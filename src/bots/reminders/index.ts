import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { buildReminderMessage } from "./blocks";
import { fetchEvents, filterUpcoming } from "./cms";

/**
 * Event reminders. `sendReminder` does the actual work (fetch → filter → post) and is shared by
 * the cron `scheduled()` handler and the `/vc-bot-admin` slash command.
 *
 * Cron triggers fire in UTC.
 * ⚠️ The cron strings in `CRON_TO_KIND` MUST stay in sync with `triggers.crons` in wrangler.jsonc.
 * TODO(reminders): both are placeholders — replace with the real UTC send-times once the intended
 * local times are supplied (a fixed UTC time shifts ±1h across DST).
 */

export interface ReminderKind {
  heading: string;
  windowHours: number;
}

export type ReminderName = "hourly" | "daily" | "weekly";

export const REMINDER_KINDS: Record<ReminderName, ReminderKind> = {
  hourly: { heading: "Starting within the hour", windowHours: 1 },
  daily: { heading: "Today at VirtualCoffee", windowHours: 24 },
  weekly: { heading: "This week at VirtualCoffee", windowHours: 24 * 7 },
};

// Maps each cron expression → reminder name. Keys must equal wrangler.jsonc cron strings.
const CRON_TO_KIND: Record<string, ReminderName> = {
  "0 * * * *": "hourly",
  "0 13 * * *": "daily",
  "0 13 * * MON": "weekly",
};

/**
 * Fetch upcoming events for a reminder window and post them to the reminders channel.
 * Returns whether a message was posted (false when there's nothing upcoming). `nowMs` is
 * injectable for tests / the cron's scheduled time.
 */
export async function sendReminder(
  kind: ReminderKind,
  env: Env,
  nowMs: number = Date.now(),
): Promise<{ posted: boolean; count: number }> {
  const events = filterUpcoming(await fetchEvents(env), kind.windowHours, nowMs);
  log.debug("reminder.window", { window: kind.windowHours, upcoming: events.length });
  if (events.length === 0) {
    log.info("reminder.skipped", { window: kind.windowHours });
    return { posted: false, count: 0 };
  }

  const { text, blocks } = buildReminderMessage(kind.heading, events);
  await createSlackClient(env).chat.postMessage({
    channel: env.SLACK_REMINDERS_CHANNEL_ID,
    text,
    blocks,
  });
  log.info("reminder.sent", { window: kind.windowHours, count: events.length });
  return { posted: true, count: events.length };
}

export async function runReminders(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const name = CRON_TO_KIND[controller.cron];
  if (!name) return; // unrecognized cron — nothing to do
  await sendReminder(REMINDER_KINDS[name], env, controller.scheduledTime);
}
