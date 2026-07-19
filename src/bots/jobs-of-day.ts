import { DurableObject } from "cloudflare:workers";
import { DateTime } from "luxon";
import { SlackAPIError } from "slack-cloudflare-workers";
import type { Env } from "../env";
import { log, setLogLevel } from "../log";
import { createSlackClient } from "../slack/client";
import { notifyBotLog } from "../slack/notify";

/** Hourly UTC tick; local-time guards below select 9am and midnight Eastern. */
export const JOBS_OF_DAY_CRON = "0 * * * *";

const ZONE = "America/New_York";
const INSTANCE_NAME = "jobs-of-day";
const ACTIVE_THREAD_KEY = "active_thread";
const LAST_POSTED_DATE_KEY = "last_posted_date";
const PENDING_POST_DATE_KEY = "pending_post_date";
const ALERTED_FAILURE_KEY = "alerted_failure";

interface ActiveThread {
  /** ISO date in America/New_York on which this thread was posted. */
  localDate: string;
  channel: string;
  ts: string;
}

export type JobTickResult =
  | { outcome: "skipped"; reason: "not-due" | "already-posted" | "weekend" }
  | { outcome: "posted"; localDate: string; ts: string }
  | { outcome: "deleted" | "retained" | "missing"; localDate: string }
  | { outcome: "failed"; action: "post" | "cleanup"; localDate: string };

/**
 * Singleton scheduler state for the Jobs of the Day thread.
 *
 * Cron delivery and Slack calls cannot be made atomic together. The in-memory queue serializes
 * overlapping RPC calls within this singleton DO, while durable state prevents duplicate
 * successful cron deliveries and gives failed calls an hourly retry path. The active message
 * pointer also means cleanup never scans channel history.
 */
export class JobsOfTheDay extends DurableObject<Env> {
  /**
   * Durable Objects may interleave requests while external fetches are pending, so routing ticks
   * through one instance is not enough by itself to serialize Slack operations. Every queued
   * promise resolves in `finally`, ensuring an unexpected failure cannot stall later ticks.
   */
  private tickQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL);
  }

  tick(scheduledTime: number): Promise<JobTickResult> {
    let release!: () => void;
    const previous = this.tickQueue;
    this.tickQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await previous;
      try {
        return await this.processTick(scheduledTime);
      } finally {
        release();
      }
    })();
  }

  private async processTick(scheduledTime: number): Promise<JobTickResult> {
    const now = DateTime.fromMillis(scheduledTime, { zone: ZONE });
    const localDate = now.toISODate();
    if (!localDate) throw new Error("Could not determine the Eastern calendar date");

    // Cleanup remains due after midnight until it succeeds. This makes Slack outages fail safe:
    // a thread is never deleted when its replies could not be inspected.
    let cleanupResult: JobTickResult | undefined;
    const active = await this.ctx.storage.get<ActiveThread>(ACTIVE_THREAD_KEY);
    if (active && active.localDate < localDate) {
      cleanupResult = await this.cleanup(active);
      if (cleanupResult.outcome === "failed") return cleanupResult;
    }

    let pendingDate = await this.ctx.storage.get<string>(PENDING_POST_DATE_KEY);
    if (pendingDate && pendingDate !== localDate) {
      await this.ctx.storage.delete(PENDING_POST_DATE_KEY);
      await this.clearAlert(`post:${pendingDate}`);
      log.warn("jobs_of_day.pending_expired", { localDate: pendingDate });
      pendingDate = undefined;
    }

    const currentActive = await this.ctx.storage.get<ActiveThread>(ACTIVE_THREAD_KEY);
    const lastPostedDate = await this.ctx.storage.get<string>(LAST_POSTED_DATE_KEY);
    if (currentActive?.localDate === localDate || lastPostedDate === localDate) {
      return { outcome: "skipped", reason: "already-posted" };
    }

    const isNineAm = now.hour === 9 && now.minute === 0;
    const isWeekday = now.weekday >= 1 && now.weekday <= 5;
    const shouldPost = pendingDate === localDate || (isNineAm && isWeekday);
    if (!shouldPost) {
      return cleanupResult ?? {
        outcome: "skipped",
        reason: isNineAm ? "weekend" : "not-due",
      };
    }

    return this.post(localDate, now);
  }

  private async post(localDate: string, now: DateTime): Promise<JobTickResult> {
    const failureKey = `post:${localDate}`;
    await this.ctx.storage.put(PENDING_POST_DATE_KEY, localDate);

    try {
      if (!this.env.SLACK_JOBS_CHANNEL_ID) {
        throw new Error("SLACK_JOBS_CHANNEL_ID is not configured");
      }
      const headingDate = now.toFormat("cccc, LLLL d");
      const text = [
        `:briefcase: *Jobs of the Day — ${headingDate}*`,
        "",
        "Share a job application or LinkedIn post about an opening in this thread.",
      ].join("\n");
      const res = await createSlackClient(this.env).chat.postMessage({
        channel: this.env.SLACK_JOBS_CHANNEL_ID,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ts) throw new Error("Slack chat.postMessage returned no message timestamp");

      const active: ActiveThread = {
        localDate,
        channel: this.env.SLACK_JOBS_CHANNEL_ID,
        ts: res.ts,
      };
      await this.ctx.storage.put({
        [ACTIVE_THREAD_KEY]: active,
        [LAST_POSTED_DATE_KEY]: localDate,
      });
      await this.ctx.storage.delete(PENDING_POST_DATE_KEY);
      await this.clearAlert(failureKey);
      log.info("jobs_of_day.posted", { localDate, channel: active.channel, ts: active.ts });
      return { outcome: "posted", localDate, ts: res.ts };
    } catch (error) {
      const message = slackError(error);
      log.error("jobs_of_day.post_failed", { localDate, error: message });
      await this.alertOnce(failureKey, "jobs_of_day.post_failed", { localDate, error: message });
      return { outcome: "failed", action: "post", localDate };
    }
  }

  private async cleanup(active: ActiveThread): Promise<JobTickResult> {
    const failureKey = `cleanup:${active.localDate}`;
    try {
      const client = createSlackClient(this.env);
      const replies = await client.conversations.replies({
        channel: active.channel,
        ts: active.ts,
        limit: 2,
      });
      const root = replies.messages?.[0];
      const hasReplies =
        (root?.reply_count ?? 0) > 0 ||
        (replies.messages ?? []).some(
          (message) => Boolean(message.ts) && message.ts !== active.ts,
        );

      if (hasReplies) {
        await this.finishCleanup(failureKey);
        log.info("jobs_of_day.retained", { localDate: active.localDate, ts: active.ts });
        return { outcome: "retained", localDate: active.localDate };
      }

      await client.chat.delete({ channel: active.channel, ts: active.ts });
      await this.finishCleanup(failureKey);
      log.info("jobs_of_day.deleted", { localDate: active.localDate, ts: active.ts });
      return { outcome: "deleted", localDate: active.localDate };
    } catch (error) {
      const code = slackError(error);
      if (code.includes("message_not_found") || code.includes("thread_not_found")) {
        await this.finishCleanup(failureKey);
        log.warn("jobs_of_day.missing", { localDate: active.localDate, ts: active.ts });
        return { outcome: "missing", localDate: active.localDate };
      }

      log.error("jobs_of_day.cleanup_failed", { localDate: active.localDate, error: code });
      await this.alertOnce(failureKey, "jobs_of_day.cleanup_failed", {
        localDate: active.localDate,
        error: code,
      });
      return { outcome: "failed", action: "cleanup", localDate: active.localDate };
    }
  }

  private async finishCleanup(failureKey: string): Promise<void> {
    await this.ctx.storage.delete(ACTIVE_THREAD_KEY);
    await this.clearAlert(failureKey);
  }

  private async alertOnce(
    failureKey: string,
    event: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    if ((await this.ctx.storage.get<string>(ALERTED_FAILURE_KEY)) === failureKey) return;
    await this.ctx.storage.put(ALERTED_FAILURE_KEY, failureKey);
    await notifyBotLog(this.env, event, fields);
  }

  private async clearAlert(failureKey: string): Promise<void> {
    if ((await this.ctx.storage.get<string>(ALERTED_FAILURE_KEY)) === failureKey) {
      await this.ctx.storage.delete(ALERTED_FAILURE_KEY);
    }
  }
}

function slackError(error: unknown): string {
  return error instanceof SlackAPIError ? error.error : String(error);
}

/** Dispatch the hourly cron into the one serialized scheduler instance. */
export async function runJobsOfTheDay(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  if (controller.cron !== JOBS_OF_DAY_CRON) return;
  try {
    const result = await env.JOBS_OF_THE_DAY.getByName(INSTANCE_NAME).tick(
      controller.scheduledTime,
    );
    log.debug("jobs_of_day.tick", { scheduledTime: controller.scheduledTime, ...result });
  } catch (error) {
    log.error("jobs_of_day.tick_failed", { error: String(error) });
    await notifyBotLog(env, "jobs_of_day.tick_failed", { error: String(error) });
  }
}
