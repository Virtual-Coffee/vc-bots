import { parseHttpUrl, parseZoomMeetingId } from "./zoom/join-link";

/**
 * Source-agnostic event model shared by the reminders bot and the calendar sync.
 *
 * Senders, Block Kit builders, and the `CalendarPort` (`src/google/calendar.ts`) speak only these
 * types — never a provider's field names. Google Calendar is the system of record (docs/adr/0001).
 */

/**
 * Where members go to attend, derived from the event's Join Link (docs/adr/0002). The union
 * makes "Zoom link without a host key" unrepresentable: the adapter rejects such an event at
 * derivation instead of producing one. A host code on a non-Zoom event is dropped.
 */
export type JoinInfo =
  /** A Zoom join url. `hostKey` (from `extendedProperties.private.hostCode`) is shown only in
   *  the event-admin mirror; never log it. */
  | { kind: "zoom"; url: string; meetingId: string; hostKey: string }
  /** Any other http(s) url — renders as the Join Event button, no host code. */
  | { kind: "url"; url: string }
  /** Free-text location — renders as a "Location:" line, not a button. */
  | { kind: "place"; text: string }
  /** No Join Link at all. */
  | { kind: "none" };

export interface ReminderEvent {
  id: string;
  title: string;
  /** ISO-8601 UTC instant (adapters do the parsing/zone work). */
  startsAt: string;
  /** Optional end time, same format. */
  endsAt?: string | null;
  /** Markdown; rendered with slackify-markdown. */
  description?: string | null;
  join: JoinInfo;
}

/** ISO range passed to the provider (computed in America/New_York). */
export interface EventRange {
  rangeStart: string;
  rangeEnd: string;
}

/** Why a timed, live event can't be announced (docs/adr/0002). */
export type InvalidEventReason = "zoom-no-host-key";

/**
 * Join Link → `JoinInfo` — the one rule every source applies (docs/adr/0002). `link` is the
 * event's Join Link (callers pass `null` for blank/whitespace). A Zoom url must come with a host
 * code (`null` when empty/whitespace) — without it the event is invalid and this returns `null`.
 * The host code is ignored for every other kind. Anything else that parses as an http(s) url is
 * `"url"`; everything else (including non-http(s) schemes like `ftp:`) is free-text `"place"`.
 */
export function deriveJoinInfo(link: string | null, hostCode: string | null): JoinInfo | null {
  if (link === null) return { kind: "none" };

  const meetingId = parseZoomMeetingId(link);
  if (meetingId !== null) {
    if (hostCode === null) return null;
    return { kind: "zoom", url: link, meetingId, hostKey: hostCode };
  }
  if (parseHttpUrl(link) !== null) return { kind: "url", url: link };
  return { kind: "place", text: link };
}
