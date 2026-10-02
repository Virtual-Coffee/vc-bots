import { DateTime } from "luxon";
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

/** The reminder kinds, each with its own event window. */
export type ReminderName = "daily" | "weekly";

/** The zone event windows are computed in (and the admin panel picks dates in). */
export const EASTERN = "America/New_York";

/** Compute a reminder kind's event window, anchored in Eastern time. */
export function reminderRange(kind: ReminderName, nowMs: number): EventRange {
  const now = DateTime.fromMillis(nowMs, { zone: EASTERN });
  if (kind === "daily") {
    // Rolling 24h window: consecutive daily runs tile exactly, so an event before
    // tomorrow's run time is announced (and scheduled) by today's run.
    return { rangeStart: toIso(now), rangeEnd: toIso(now.plus({ days: 1 })) };
  }
  // The announced week: Monday 00:00 → next Monday 00:00 (Mon–Sun), in Eastern. Anchored to the
  // start of the ISO week (Luxon `startOf("week")` is Monday-start), NOT to the run time, so the
  // window is the same set the Monday weekly summary covers no matter which day this is called —
  // the CalendarSync change-notices reuse this so they match exactly what members were told.
  const weekStart = now.startOf("week");
  return { rangeStart: toIso(weekStart), rangeEnd: toIso(weekStart.plus({ weeks: 1 })) };
}

function toIso(dt: DateTime): string {
  // fromMillis with a fixed zone is always valid; the fallback keeps TS strictness honest.
  return dt.toISO() ?? new Date(dt.toMillis()).toISOString();
}
