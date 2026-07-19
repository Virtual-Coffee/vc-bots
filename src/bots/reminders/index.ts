import { DateTime } from "luxon";
import type { ChatScheduledMessagesListRequest, SlackAPIClient } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { notifyBotLog } from "../../slack/notify";
import {
  buildDailyMessage,
  buildStartingSoonAdminMessage,
  buildStartingSoonMessage,
  buildWeeklyMessage,
} from "./blocks";
import type { EventRange, EventSource, ReminderEvent, ReminderName } from "./source";
import { getEventSource, reminderRange } from "./source";

export type { ReminderName } from "./source";

/**
 * Event announcements. `sendReminder` does the actual work and is shared by the cron
 * `scheduled()` handler and the `/vc-bot-admin` slash command.
 *
 * - `daily` (12:00 UTC): schedules each event's "Starting Soon" message (and an event-admin
 *   mirror) for start − 10 min via `chat.scheduleMessage`, then posts the "Today's Events"
 *   summary — except Mondays, when the weekly summary covers it (scheduling still runs).
 * - `weekly` (Mondays 12:00 UTC): posts the "This Week's Events" summary.
 *
 * Cron triggers fire in UTC; 12:00 UTC = 8am EDT / 7am EST (accepted DST drift).
 * ⚠️ The cron strings in `CRON_TO_KIND` MUST stay byte-identical to their entries in
 * `triggers.crons` in wrangler.jsonc. Other bot features may have additional cron entries.
 */

// Maps each event cron expression → reminder name. Keys must equal their wrangler cron strings.
const CRON_TO_KIND: Record<string, ReminderName> = {
  "0 12 * * *": "daily",
  "0 12 * * 1": "weekly",
};

/** Post the starting-soon pair this many seconds before the event starts. */
const STARTING_SOON_LEAD_SECONDS = 600;
/** Slack rejects `post_at` values in the near past — post immediately below this margin. */
const MIN_SCHEDULE_AHEAD_SECONDS = 60;

export interface SendResult {
  /** Whether the daily/weekly summary was posted. */
  posted: boolean;
  /** Events found in the window. */
  count: number;
  /** Starting-soon message pairs scheduled or posted (daily only). */
  scheduled?: number;
  /** Why no summary was posted. */
  reason?: "monday" | "no-events";
}

type Sender = (source: EventSource, env: Env, nowMs: number) => Promise<SendResult>;

const SENDERS: Record<ReminderName, Sender> = {
  daily: sendDaily,
  weekly: sendWeekly,
};

/**
 * Run one reminder kind. `nowMs` is injectable for tests / the cron's scheduled time.
 * (When the Google Calendar source lands, an optional source name threads through here so
 * `/vc-bot-admin` can preview either source.)
 */
export async function sendReminder(
  name: ReminderName,
  env: Env,
  nowMs: number = Date.now(),
): Promise<SendResult> {
  return SENDERS[name](getEventSource(env), env, nowMs);
}

export async function runReminders(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const name = CRON_TO_KIND[controller.cron];
  if (!name) return; // unrecognized cron — nothing to do
  try {
    await sendReminder(name, env, controller.scheduledTime);
  } catch (error) {
    // No user surface on the cron path — log, alert #bot-log, and swallow so a CMS/Slack
    // hiccup doesn't surface as an unhandled rejection in `scheduled()`.
    log.error("reminder.run_failed", { cron: controller.cron, error: String(error) });
    await notifyBotLog(env, "reminder.run_failed", { cron: controller.cron, error: String(error) });
  }
}

async function sendDaily(source: EventSource, env: Env, nowMs: number): Promise<SendResult> {
  const range = reminderRange("daily", nowMs);
  const events = await source.fetchEvents(range);
  const client = createSlackClient(env);

  const scheduled = await scheduleStartingSoon(client, env, events, nowMs, range);

  // Mondays get the weekly summary instead; the starting-soon scheduling above still ran.
  if (DateTime.fromMillis(nowMs, { zone: "America/New_York" }).weekday === 1) {
    log.info("reminder.daily_monday_skip", { count: events.length, scheduled });
    return { posted: false, count: events.length, scheduled, reason: "monday" };
  }
  if (events.length === 0) {
    log.info("reminder.skipped", { kind: "daily" });
    return { posted: false, count: 0, scheduled, reason: "no-events" };
  }

  const { text, blocks } = buildDailyMessage(events);
  await client.chat.postMessage({
    channel: env.SLACK_ANNOUNCEMENTS_CHANNEL_ID,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  log.info("reminder.sent", { kind: "daily", count: events.length, scheduled });
  return { posted: true, count: events.length, scheduled };
}

async function sendWeekly(source: EventSource, env: Env, nowMs: number): Promise<SendResult> {
  const range = reminderRange("weekly", nowMs);
  const events = await source.fetchEvents(range);
  if (events.length === 0) {
    log.info("reminder.skipped", { kind: "weekly" });
    return { posted: false, count: 0, reason: "no-events" };
  }

  const { text, blocks } = buildWeeklyMessage(events);
  await createSlackClient(env).chat.postMessage({
    channel: env.SLACK_ANNOUNCEMENTS_CHANNEL_ID,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  log.info("reminder.sent", { kind: "weekly", count: events.length });
  return { posted: true, count: events.length };
}

/**
 * Schedule each event's starting-soon pair (public announcement + event-admin mirror) for
 * start − 10 min. Clears this bot's scheduled messages in the window first, so re-runs
 * (manual `/vc-bot-admin daily`) reconcile instead of duplicating. Events starting too soon
 * to schedule are posted immediately; already-started events are skipped.
 */
async function scheduleStartingSoon(
  client: SlackAPIClient,
  env: Env,
  events: ReminderEvent[],
  nowMs: number,
  range: EventRange,
): Promise<number> {
  await clearScheduledInWindow(client, nowMs, range);

  const nowSeconds = Math.floor(nowMs / 1000);
  let handled = 0;
  for (const event of events) {
    const startSeconds = Math.floor(DateTime.fromISO(event.startsAt, { zone: "utc" }).toSeconds());
    if (startSeconds <= nowSeconds) {
      log.info("reminder.event_already_started", { id: event.id, startsAt: event.startsAt });
      continue;
    }

    const channel = env.SLACK_EVENTS_CHANNEL_ID;
    const message = buildStartingSoonMessage(event);
    const adminMessage = buildStartingSoonAdminMessage(event, channel);
    const postAt = startSeconds - STARTING_SOON_LEAD_SECONDS;
    const common = { unfurl_links: false, unfurl_media: false };

    if (postAt > nowSeconds + MIN_SCHEDULE_AHEAD_SECONDS) {
      await client.chat.scheduleMessage({ channel, post_at: postAt, ...message, ...common });
      await client.chat.scheduleMessage({
        channel: env.SLACK_EVENTADMIN_CHANNEL_ID,
        post_at: postAt,
        ...adminMessage,
        ...common,
      });
      log.debug("reminder.scheduled", {
        id: event.id,
        channel,
        postAt,
        postAtEST: DateTime.fromSeconds(postAt, { zone: "America/New_York" }).toISO(),
      });
    } else {
      // The −10 min slot is already past (or too near for Slack) but the event hasn't
      // started — announce right away instead.
      await client.chat.postMessage({ channel, ...message, ...common });
      await client.chat.postMessage({
        channel: env.SLACK_EVENTADMIN_CHANNEL_ID,
        ...adminMessage,
        ...common,
      });
      log.info("reminder.posted_immediately", { id: event.id, channel });
    }
    handled += 1;
  }
  return handled;
}

/** Delete this bot's scheduled messages with `post_at` inside the window (all channels). */
async function clearScheduledInWindow(
  client: SlackAPIClient,
  nowMs: number,
  range: EventRange,
): Promise<void> {
  const oldest = Math.floor(nowMs / 1000);
  const latest = Math.floor(DateTime.fromISO(range.rangeEnd).toSeconds());

  // Collect everything first, then delete — deleting while paginating can skew cursors.
  const targets: Array<{ channel: string; id: string }> = [];
  let cursor: string | undefined;
  do {
    // Slack allows omitting `channel` to list across all channels (which the sweep needs);
    // the client's type over-narrows it to required, hence the cast.
    const res = await client.chat.scheduledMessages.list({
      oldest,
      latest,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    } as ChatScheduledMessagesListRequest);
    for (const msg of res.scheduled_messages ?? []) {
      if (msg.id && msg.channel_id) targets.push({ channel: msg.channel_id, id: msg.id });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  for (const target of targets) {
    await client.chat.deleteScheduledMessage({
      channel: target.channel,
      scheduled_message_id: target.id,
    });
  }
  if (targets.length > 0) {
    log.info("reminder.cleared_scheduled", { count: targets.length });
  }
}
