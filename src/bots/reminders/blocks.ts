import type { AnyMessageBlock } from "slack-web-api-client";
import { DateTime } from "luxon";
import type { CmsEvent } from "./cms";
import { htmlToMrkdwn } from "./html-to-mrkdwn";

/**
 * Block Kit builders for event-reminder messages.
 *
 * Times are rendered with Slack's `<!date^…>` token so each member sees them in their own
 * timezone. HTML descriptions are converted to Slack mrkdwn with slackify-html.
 */

export interface ReminderMessage {
  text: string;
  blocks: AnyMessageBlock[];
}

export function buildReminderMessage(heading: string, events: CmsEvent[]): ReminderMessage {
  const text = `${heading} — ${events.length} event${events.length === 1 ? "" : "s"}`;

  const blocks: AnyMessageBlock[] = [
    { type: "header", text: { type: "plain_text", text: heading, emoji: true } },
  ];

  for (const event of events) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: eventLine(event) } });
  }

  return { text, blocks };
}

function eventLine(event: CmsEvent): string {
  const title = event.url ? `<${event.url}|${event.title}>` : `*${event.title}*`;
  const when = formatStart(event.startsAt);
  const lines = [`*${title}*`, when];
  if (event.description) {
    lines.push(htmlToMrkdwn(event.description));
  }
  return lines.filter(Boolean).join("\n");
}

/** Render an ISO start time as a per-viewer Slack date token (falls back to the raw value). */
function formatStart(startsAt: string): string {
  const dt = DateTime.fromISO(startsAt, { zone: "utc" });
  if (!dt.isValid) return startsAt;
  const unix = Math.floor(dt.toMillis() / 1000);
  const fallback = dt.toFormat("ccc d LLL, HH:mm 'UTC'");
  return `:calendar: <!date^${unix}^{date_short_pretty} at {time}|${fallback}>`;
}
