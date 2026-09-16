import { DateTime } from "luxon";
import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { notifyBotLog } from "../../slack/notify";
import { buildDailyMessage, buildWeeklyMessage } from "./blocks";
import type { EventSource, ReminderName } from "./source";
import { activeSourceName, getEventSource, reminderRange } from "./source";
import { reconcileStartingSoon } from "./starting-soon";

export type { ReminderName } from "./source";
export { activeSourceName, EASTERN, EVENT_SOURCE_NAMES, isEventSourceName } from "./source";

/**
 * Event announcements. `sendReminder` does the actual work and is shared by the cron
 * `scheduled()` handler and the `/vc-bot-admin` slash command.
 *
 * - `daily` (12:00 UTC): schedules each event's "Starting Soon" message (and an event-admin
 *   mirror) for start − 10 min via `chat.scheduleMessage`, then posts the "Today's Events"
 *   summary — except Mondays, when the weekly summary covers it (scheduling still runs).
 * - `weekly` (Mondays 12:00 UTC): posts the "This Week's Events" summary.
 *
 * Cron triggers fire in UTC; 12:00 UTC = 8am EDT / 7am EST (accepted DST drift). Both crons
 * are live in wrangler.jsonc.
 * ⚠️ The cron strings in `CRON_TO_KIND` MUST stay byte-identical to `triggers.crons` in
 * wrangler.jsonc — `controller.cron` is the configured expression character-for-character,
 * so a mismatch means that reminder silently never runs.
 * ⚠️ Cloudflare parses cron weekdays Quartz-style (1 = Sunday … 7 = Saturday), so the weekday
 * is spelled `MON` rather than a number. Unrelated to the Luxon `weekday === 1` check in
 * `sendDaily`, which is ISO (1 = Monday) and correct as written.
 */

// Maps each cron expression → reminder name. Keys must equal wrangler.jsonc cron strings.
const CRON_TO_KIND: Record<string, ReminderName> = {
  "0 12 * * *": "daily",
  "0 12 * * MON": "weekly",
};

export interface SendResult {
  /** Whether the daily/weekly summary was posted. */
  posted: boolean;
  /** Events found in the window. */
  count: number;
  /** Starting-soon message pairs scheduled or posted (daily only). */
  scheduled?: number;
  /** Why no summary was posted. */
  reason?: "monday" | "no-events";
  /** Name of the event source used. */
  source: string;
}

type Sender = (source: EventSource, env: Env, nowMs: number) => Promise<SendResult>;

const SENDERS: Record<ReminderName, Sender> = {
  daily: sendDaily,
  weekly: sendWeekly,
};

/**
 * Run one reminder kind. `nowMs` is injectable for tests / the cron's scheduled time.
 * `sourceName` lets `/vc-bot-admin` run a named source; omit to use `env.EVENT_SOURCE`
 * (or "google" default). The cron handler never passes a source name.
 */
export async function sendReminder(
  name: ReminderName,
  env: Env,
  nowMs: number = Date.now(),
  sourceName?: string,
): Promise<SendResult> {
  return SENDERS[name](getEventSource(env, sourceName), env, nowMs);
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
    // No user surface on the cron path — log, alert #bot-log, and swallow so a Calendar/Zoom/
    // Slack hiccup doesn't surface as an unhandled rejection in `scheduled()`.
    log.error("reminder.run_failed", { cron: controller.cron, error: String(error) });
    await notifyBotLog(env, "reminder.run_failed", { cron: controller.cron, error: String(error) });
  }

  // Bootstrap/heal the Calendar watch and its snapshot baseline on the daily run when Google is
  // the active source. `ensureWatch` seeds only when the baseline is missing (first run) or the
  // announced week rolled over (Monday) — it must NOT reseed daily: a snapshot overwrite would
  // swallow a change whose push is still queued behind it, so the cancellation/reschedule would
  // never be announced. Guarded separately so a watch hiccup never masks the reminder result.
  if (name === "daily" && activeSourceName(env) === "google") {
    try {
      await env.CALENDAR_SYNC.getByName("default").ensureWatch();
    } catch (error) {
      log.error("calendar_sync.bootstrap_failed", { error: String(error) });
      await notifyBotLog(env, "calendar_sync.bootstrap_failed", { error: String(error) });
    }
  }
}

async function sendDaily(source: EventSource, env: Env, nowMs: number): Promise<SendResult> {
  const range = reminderRange("daily", nowMs);
  const events = await source.fetchEvents(range);
  const client = createSlackClient(env);

  const scheduled = await reconcileStartingSoon(client, env, events, nowMs, range);

  // Mondays get the weekly summary instead; the starting-soon scheduling above still ran.
  if (DateTime.fromMillis(nowMs, { zone: "America/New_York" }).weekday === 1) {
    log.info("reminder.daily_monday_skip", { count: events.length, scheduled });
    return { posted: false, count: events.length, scheduled, reason: "monday", source: source.name };
  }
  if (events.length === 0) {
    log.info("reminder.skipped", { kind: "daily" });
    return { posted: false, count: 0, scheduled, reason: "no-events", source: source.name };
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
  return { posted: true, count: events.length, scheduled, source: source.name };
}

async function sendWeekly(source: EventSource, env: Env, nowMs: number): Promise<SendResult> {
  const range = reminderRange("weekly", nowMs);
  const events = await source.fetchEvents(range);
  if (events.length === 0) {
    log.info("reminder.skipped", { kind: "weekly" });
    return { posted: false, count: 0, reason: "no-events", source: source.name };
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
  return { posted: true, count: events.length, source: source.name };
}
