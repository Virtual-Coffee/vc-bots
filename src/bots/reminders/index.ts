import { DateTime } from "luxon";
import type { Env } from "../../env";
import { type CalendarPort, createGoogleCalendarPort } from "../../google/calendar";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { buildDailyMessage, buildWeeklyMessage } from "./blocks";
import type { ReminderName } from "../../events";
import { reminderRange } from "../../events";
import { reconcileStartingSoon } from "./starting-soon";

/**
 * Event announcements. `sendReminder` does the actual work and is shared by the cron schedule
 * (`src/cron.ts`) and the `/vc-bot-admin` slash command.
 *
 * - `daily` (12:00 UTC): schedules each event's "Starting Soon" message (and an event-admin
 *   mirror) for start − 10 min via `chat.scheduleMessage`, then posts the "Today's Events"
 *   summary — except Mondays, when the weekly summary covers it (scheduling still runs).
 * - `weekly` (Mondays 12:00 UTC): posts the "This Week's Events" summary.
 */

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

type Sender = (calendar: CalendarPort, env: Env, nowMs: number) => Promise<SendResult>;

const SENDERS: Record<ReminderName, Sender> = {
  daily: sendDaily,
  weekly: sendWeekly,
};

/** Run one reminder kind. `nowMs` is injectable for tests / the cron's scheduled time. */
export async function sendReminder(
  name: ReminderName,
  env: Env,
  nowMs: number = Date.now(),
): Promise<SendResult> {
  return SENDERS[name](createGoogleCalendarPort(env), env, nowMs);
}

async function sendDaily(calendar: CalendarPort, env: Env, nowMs: number): Promise<SendResult> {
  const range = reminderRange("daily", nowMs);
  const events = await calendar.listEvents(range);
  const client = createSlackClient(env);

  const scheduled = await reconcileStartingSoon(client, env, events, nowMs, range);

  // Mondays get the weekly summary instead; the starting-soon scheduling above still ran.
  if (DateTime.fromMillis(nowMs, { zone: "America/New_York" }).weekday === 1) {
    log.info("reminder.daily_monday_skip", { count: events.length, scheduled });
    return { posted: false, count: events.length, scheduled, reason: "monday" };
  }
  if (events.length === 0) {
    log.info("reminder.skipped", { kind: "daily" });
    return { posted: false, count: 0, scheduled, reason: "no-events" };
  }

  const { text, blocks } = buildDailyMessage(events, env.SLACK_EVENTS_CHANNEL_ID);
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

async function sendWeekly(calendar: CalendarPort, env: Env, nowMs: number): Promise<SendResult> {
  const range = reminderRange("weekly", nowMs);
  const events = await calendar.listEvents(range);
  if (events.length === 0) {
    log.info("reminder.skipped", { kind: "weekly" });
    return { posted: false, count: 0, reason: "no-events" };
  }

  const { text, blocks } = buildWeeklyMessage(events, env.SLACK_EVENTS_CHANNEL_ID);
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
