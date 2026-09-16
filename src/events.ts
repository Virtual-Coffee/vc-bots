/**
 * Source-agnostic event model shared by the reminders bot and the calendar sync.
 *
 * Senders, Block Kit builders, and the `CalendarPort` (`src/google/calendar.ts`) speak only these
 * types — never a provider's field names. Google Calendar is the system of record (docs/adr/0001).
 */

export interface ReminderEvent {
  id: string;
  title: string;
  /** ISO-8601 UTC instant (adapters do the parsing/zone work). */
  startsAt: string;
  /** Optional end time, same format. */
  endsAt?: string | null;
  /** Markdown; rendered with slackify-markdown. */
  description?: string | null;
  /** URL or free-text location (a non-URL renders as a "Location:" line, not a button). */
  joinLink?: string | null;
  /** Zoom host key from `extendedProperties.private.hostCode`; shown only in the event-admin
   *  mirror; never log it. */
  hostKey?: string | null;
}

/** ISO range passed to the provider (computed in America/New_York). */
export interface EventRange {
  rangeStart: string;
  rangeEnd: string;
}
