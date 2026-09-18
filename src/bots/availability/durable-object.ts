import { DurableObject } from "cloudflare:workers";
import { SlackAPIError } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log, setLogLevel } from "../../log";
import { createSlackClient } from "../../slack/client";
import {
  buildDayMessage,
  buildIntroMessage,
  DAYS,
  emptySheet,
  ROLES,
  sheetFromReactions,
  weekDays,
  type Day,
} from "./message";

/**
 * The weekly availability check-in. One instance per availability channel
 * (`env.AVAILABILITY_SHEET.getByName(channelId)`).
 *
 * Slack's reaction list is the source of truth for who signed up (ADR 0009): this DO stores
 * only the two day-message `ts` pointers (plus the cached bot user id) and re-renders a day
 * message from `reactions.get` on every refresh, so a dropped or duplicated reaction event
 * self-heals on the next one. No SQL tables → no migration step.
 *
 * ⚠️ Input gates only cover storage ops; other requests are delivered while a handler awaits a
 * Slack `fetch`. `inflight` is the serialization primitive for refreshes: concurrent refreshes
 * of one message coalesce into "one more render after the current one" (same lesson as ADR 0003).
 */

/** This week's day-message pointers, plus when they were posted (so a refresh re-renders the same dates). */
interface DayMessages {
  tuesday: string;
  thursday: string;
  postedAtMs: number;
}

const DAY_MESSAGES_KEY = "day_messages";
const BOT_USER_ID_KEY = "bot_user_id";

export type RefreshResult = "refreshed" | "ignored";

export class AvailabilitySheet extends DurableObject<Env> {
  private readonly inflight = new Map<string, { done: Promise<void>; dirty: boolean }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL); // the DO runs in its own isolate
  }

  /**
   * Post the Monday trio (intro → Tuesday → Thursday) and seed each day message with the five
   * role reactions so people can one-click. Always posts fresh and repoints: an older trio
   * simply stops updating. Pointers are stored *before* seeding so a human reaction that lands
   * mid-seed is already recognized.
   */
  async post(nowMs: number = Date.now()): Promise<Record<Day, string>> {
    const channel = this.env.SLACK_AVAILABILITY_CHANNEL_ID;
    const client = createSlackClient(this.env);
    const dates = weekDays(nowMs);

    const intro = buildIntroMessage();
    await client.chat.postMessage({ channel, ...intro });

    const ts: Partial<Record<Day, string>> = {};
    for (const day of DAYS) {
      const message = buildDayMessage(day, dates[day], emptySheet());
      const res = await client.chat.postMessage({ channel, ...message });
      if (!res.ts) throw new Error(`chat.postMessage returned no ts for ${day}`);
      ts[day] = res.ts;
    }
    const dayMessages: DayMessages = { ...(ts as Record<Day, string>), postedAtMs: nowMs };
    await this.ctx.storage.put(DAY_MESSAGES_KEY, dayMessages);
    log.info("availability.posted", { channel, tuesday: ts.tuesday, thursday: ts.thursday });

    for (const day of DAYS) {
      for (const { reaction } of ROLES) {
        try {
          await client.reactions.add({ channel, timestamp: dayMessages[day], name: reaction });
        } catch (err) {
          if (slackErrorCode(err) === "already_reacted") continue;
          throw err;
        }
      }
    }
    return { tuesday: dayMessages.tuesday, thursday: dayMessages.thursday };
  }

  /**
   * Re-render the day message `ts` from its current reactions. `"ignored"` when `ts` isn't one
   * of this week's day messages or the reactor is the bot itself (its seed reactions fire
   * events too — `ignoreSelfEvents: false`, ADR 0007).
   */
  async refresh(ts: string, reactorUserId?: string): Promise<RefreshResult> {
    const dayMessages = await this.ctx.storage.get<DayMessages>(DAY_MESSAGES_KEY);
    const day = DAYS.find((d) => dayMessages?.[d] === ts);
    if (!day || !dayMessages) return "ignored";
    if (reactorUserId && reactorUserId === (await this.botUserId())) return "ignored";

    const inflight = this.inflight.get(ts);
    if (inflight) {
      inflight.dirty = true; // one more render after the current one covers every event so far
      log.info("availability.refresh.coalesced", { ts });
      await inflight.done;
      return "refreshed";
    }
    const entry = { dirty: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.dirty = false;
          await this.render(day, ts, dayMessages.postedAtMs);
        } while (entry.dirty);
      } finally {
        this.inflight.delete(ts);
      }
    })();
    this.inflight.set(ts, entry);
    await entry.done;
    return "refreshed";
  }

  /** The bot's own user id, so its seed reactions never count as sign-ups. Cached after one `auth.test`. */
  private async botUserId(): Promise<string | undefined> {
    const cached = await this.ctx.storage.get<string>(BOT_USER_ID_KEY);
    if (cached) return cached;
    const { user_id } = await createSlackClient(this.env).auth.test();
    if (user_id) await this.ctx.storage.put(BOT_USER_ID_KEY, user_id);
    return user_id;
  }

  private async render(day: Day, ts: string, postedAtMs: number): Promise<void> {
    const channel = this.env.SLACK_AVAILABILITY_CHANNEL_ID;
    const client = createSlackClient(this.env);
    const botUserId = await this.botUserId();
    try {
      const res = await client.reactions.get({ channel, timestamp: ts, full: true });
      const sheet = sheetFromReactions(res.message?.reactions, botUserId);
      const message = buildDayMessage(day, weekDays(postedAtMs)[day], sheet);
      await client.chat.update({ channel, ts, ...message });
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === "message_not_found" || code === "channel_not_found") {
        log.warn("availability.message_vanished", { ts, error: code });
        return;
      }
      throw err;
    }
  }
}

function slackErrorCode(err: unknown): string {
  return err instanceof SlackAPIError ? err.error : String(err);
}
