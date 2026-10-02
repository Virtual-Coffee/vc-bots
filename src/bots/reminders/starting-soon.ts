import { DateTime } from "luxon";
import type {
  AnyMessageBlock,
  ChatScheduledMessagesListRequest,
  SlackAPIClient,
} from "slack-cloudflare-workers";
import type { Env } from "../../env";
import type { CalendarPort } from "../../google/calendar";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { descriptionContext, fallbackDate, header, section, titleSection } from "./blocks";
import type { ReminderMessage } from "./blocks";
import { type EventRange, type ReminderEvent, reminderRange } from "../../events";

/**
 * The per-event "Starting Soon" pair: a public announcement to the events channel and an
 * event-admin mirror carrying the host key, scheduled for start − 10 min. `syncStartingSoon`
 * sweeps the bot's already-scheduled messages in the window before re-queuing, so re-runs
 * replace instead of duplicating.
 */

/** What started a starting-soon sync (docs/adr/0005). */
export type StartingSoonTrigger = "daily-run" | "calendar-change";

/** Post the starting-soon pair this many seconds before the event starts. */
const STARTING_SOON_LEAD_SECONDS = 600;
/** Slack rejects `post_at` values in the near past — post immediately below this margin. */
const MIN_SCHEDULE_AHEAD_SECONDS = 60;

/** Per-event "⏰ Starting Soon" announcement, scheduled to post ~10 min before the event. */
export function buildStartingSoonMessage(event: ReminderEvent): ReminderMessage {
  const blocks: AnyMessageBlock[] = [header("⏰ Starting Soon:"), titleSection(event, true)];
  if (event.join.kind === "place") {
    blocks.push(section(`*Location:* ${event.join.text}`));
  }
  const description = descriptionContext(event);
  if (description) blocks.push(description);
  blocks.push({ type: "divider" });

  return { text: `Starting soon: ${event.title}: ${fallbackDate(event)}`, blocks };
}

/** Event-admin mirror of the starting-soon message, with host info for moderators. */
export function buildStartingSoonAdminMessage(
  event: ReminderEvent,
  targetChannelId: string,
): ReminderMessage {
  const blocks: AnyMessageBlock[] = [header("⏰ Starting Soon:"), titleSection(event, true)];
  const { join } = event;
  if (join.kind === "zoom" || join.kind === "url") {
    blocks.push(section(`*Location:* ${join.url}`));
  } else if (join.kind === "place") {
    blocks.push(section(`*Location:* ${join.text}`));
  }
  if (join.kind === "zoom") blocks.push(section(`*Host Code:* ${join.hostKey}`));
  blocks.push(section(`*Announcement posted to:* <#${targetChannelId}>`), { type: "divider" });

  return { text: `Starting soon: ${event.title}: ${fallbackDate(event)}`, blocks };
}

/**
 * Starting-soon sync: re-queue the starting-soon pairs for the next 24h. Lists the daily window
 * through `calendar`, sweeps the bot's pending scheduled messages in it, then schedules (or
 * posts now) each event's pair. Returns the window's `events` and the number of pairs handled.
 * `trigger` decides what a fired slot means — docs/adr/0005. The event-admin mirror carries the
 * event's host key; a Zoom event without one never reaches here (docs/adr/0002).
 */
export async function syncStartingSoon(
  calendar: CalendarPort,
  env: Env,
  nowMs: number,
  trigger: StartingSoonTrigger,
): Promise<{ events: ReminderEvent[]; scheduled: number }> {
  const range = reminderRange("daily", nowMs);
  const events = await calendar.listEvents(range);
  const client = createSlackClient(env);
  const nowSeconds = Math.floor(nowMs / 1000);
  const startSecondsOf = (event: ReminderEvent): number =>
    Math.floor(DateTime.fromISO(event.startsAt, { zone: "utc" }).toSeconds());

  await clearScheduledInWindow(client, nowMs, range);

  let scheduled = 0;
  for (const event of events) {
    const startSeconds = startSecondsOf(event);
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
    } else if (postAt <= nowSeconds && trigger === "calendar-change") {
      // The slot already fired (Slack delivered the scheduled pair, or the daily run posted it
      // immediately) and the sweep only sees pending messages — re-posting would duplicate.
      log.info("reminder.slot_already_fired", { id: event.id, postAt });
      continue;
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
    scheduled += 1;
  }
  return { events, scheduled };
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
