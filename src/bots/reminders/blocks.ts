import type { AnyMessageBlock, MessageAttachment } from "slack-cloudflare-workers";
import { DateTime } from "luxon";
import { dateToken } from "../../slack/date";
import { slackifyMarkdown } from "slackify-markdown";
import type { ReminderEvent } from "./source";

/**
 * Block Kit builders for event announcements, ported layout-for-layout from the old
 * Netlify webhooks bot.
 *
 * Times are rendered with Slack's `<!date^…>` token so each member sees them in their own
 * timezone. Markdown descriptions are converted to Slack mrkdwn with `slackify-markdown`.
 */

export interface ReminderMessage {
  text: string;
  blocks: AnyMessageBlock[];
  attachments?: MessageAttachment[];
}

/** Per-event "⏰ Starting Soon" announcement, scheduled to post ~10 min before the event. */
export function buildStartingSoonMessage(event: ReminderEvent): ReminderMessage {
  const blocks: AnyMessageBlock[] = [header("⏰ Starting Soon:"), titleSection(event, true)];
  const link = event.joinLink;
  if (link && !link.startsWith("http")) {
    blocks.push(section(`*Location:* ${link}`));
  }
  const description = descriptionContext(event);
  if (description) blocks.push(description);
  blocks.push({ type: "divider" });

  return { text: `Starting soon: ${event.title}: ${fallbackDate(event)}`, blocks };
}

/** Event-admin mirror of the starting-soon message, with host info for moderators. `hostKey`
 *  is the Zoom host key resolved at send time (`src/zoom/host-key.ts`); null = no Zoom meeting. */
export function buildStartingSoonAdminMessage(
  event: ReminderEvent,
  targetChannelId: string,
  hostKey: string | null,
): ReminderMessage {
  const blocks: AnyMessageBlock[] = [header("⏰ Starting Soon:"), titleSection(event, true)];
  if (event.joinLink) blocks.push(section(`*Location:* ${event.joinLink}`));
  if (hostKey) blocks.push(section(`*Host Code:* ${hostKey}`));
  blocks.push(section(`*Announcement posted to:* <#${targetChannelId}>`), { type: "divider" });

  return { text: `Starting soon: ${event.title}: ${fallbackDate(event)}`, blocks };
}

/** "Today's Events" summary for the announcements channel. */
export function buildDailyMessage(events: ReminderEvent[]): ReminderMessage {
  const blocks: AnyMessageBlock[] = [header("📆 Today's Events Are:")];
  for (const event of events) {
    blocks.push(titleSection(event, false));
    const description = descriptionContext(event);
    if (description) blocks.push(description);
    blocks.push(
      context("ℹ️ Link to join will be posted about 10 minutes before the event starts."),
      { type: "divider" },
    );
  }

  return { text: `Today's events are: ${eventListText(events)}`, blocks };
}

/** "This Week's Events" summary for the announcements channel. */
export function buildWeeklyMessage(events: ReminderEvent[]): ReminderMessage {
  const blocks: AnyMessageBlock[] = [
    header("📆 This Week's Events Are:"),
    ...events.map((event) =>
      section(`*${eventDateToken(event)}*\n${event.title}`),
    ),
    context("ℹ️ Links to join will be posted about 10 minutes before the event starts."),
    { type: "divider" as const },
    context("See details and more events at <https://virtualcoffee.io/events|VirtualCoffee.IO>!"),
  ];

  return { text: `This weeks events are: ${eventListText(events)}`, blocks };
}

function eventStart(event: ReminderEvent): DateTime {
  return DateTime.fromISO(event.startsAt, { zone: "utc" });
}

/** Slack display + plain-text fallback formats for an event's start. `eventStart` is UTC-zoned,
 *  so the fallback reads in UTC. */
const EVENT_DATE_FORMAT = "{date_long_pretty} {time}";
const EVENT_FALLBACK_FORMAT = "EEEE, fff";

/** Per-viewer Slack date token for an event's start. */
function eventDateToken(event: ReminderEvent): string {
  return dateToken(eventStart(event), EVENT_DATE_FORMAT, EVENT_FALLBACK_FORMAT);
}

function fallbackDate(event: ReminderEvent): string {
  return eventStart(event).toFormat(EVENT_FALLBACK_FORMAT);
}

function eventListText(events: ReminderEvent[]): string {
  return events.map((e) => `${e.title}: ${fallbackDate(e)}`).join(", ");
}

/** action_id of the Starting Soon "Join Event" button. Slack fires a `block_actions` interaction
 *  for url buttons too, so this must stay registered in `src/slack/app.ts` — an unregistered
 *  action 404s and Slack flags the click with a warning triangle. No lazy handler is needed: the
 *  `url` does the navigating. ⚠️ Don't rename it to match the `coworking_*` convention —
 *  starting-soon messages are queued a day ahead via `chat.scheduleMessage`, so already-posted
 *  and already-scheduled buttons carry this exact string. */
export const JOIN_EVENT_ACTION_ID = "button-join-event";

/** Bold title + date token; a Join Event button only for real URLs (when asked for). */
function titleSection(event: ReminderEvent, withButton: boolean): AnyMessageBlock {
  const text = {
    type: "mrkdwn" as const,
    text: `*${event.title}*\n${eventDateToken(event)}`,
  };
  const link = event.joinLink;
  if (withButton && link && link.startsWith("http")) {
    return {
      type: "section",
      text,
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Join Event", emoji: true },
        value: `join_event_${event.id}`,
        url: link,
        action_id: JOIN_EVENT_ACTION_ID,
      },
    };
  }
  return { type: "section", text };
}

/** Description as a context block; omitted when empty (Slack rejects empty context elements). */
function descriptionContext(event: ReminderEvent): AnyMessageBlock | null {
  const text = event.description ? slackifyMarkdown(event.description).trim() : "";
  if (!text) return null;
  return context(text);
}

function header(text: string): AnyMessageBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function section(text: string): AnyMessageBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): AnyMessageBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** Standout notice that an event in the announced window was cancelled. */
export function buildCancellationMessage(event: ReminderEvent): ReminderMessage {
  return {
    text: `Cancelled: ${event.title} — ${fallbackDate(event)}`,
    blocks: [],
    attachments: [
      {
        color: "#d9376e",
        blocks: [
          section("*:warning: Event Cancelled*"),
          section(`*${event.title}*\n${eventDateToken(event)}`),
          section("This event has been cancelled."),
        ],
      },
    ],
  };
}

/** Standout notice that an event was rescheduled from oldStartsAt to its new start. */
export function buildRescheduleMessage(
  event: ReminderEvent,
  oldStartsAt: string,
): ReminderMessage {
  const oldDt = DateTime.fromISO(oldStartsAt, { zone: "utc" });
  return {
    text: `Rescheduled: ${event.title} — now ${fallbackDate(event)}`,
    blocks: [],
    attachments: [
      {
        color: "#d9376e",
        blocks: [
          section("*:calendar: Event Rescheduled*"),
          section(`*${event.title}*`),
          section(`*Was:* ${dateToken(oldDt, EVENT_DATE_FORMAT, EVENT_FALLBACK_FORMAT)}`),
          section(`*Now:* ${eventDateToken(event)}`),
        ],
      },
    ],
  };
}
