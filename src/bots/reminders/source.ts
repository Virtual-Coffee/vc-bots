import { DateTime } from "luxon";
import type { Env } from "../../env";
import { createCmsSource } from "./sources/cms";
import { createGoogleCalendarSource } from "./sources/google-calendar";

/**
 * Source-agnostic event model for the reminders bot.
 *
 * Senders and Block Kit builders depend only on these types — never on a provider's field
 * names. The CMS (Craft + Solspace Calendar) is the first `EventSource`; the Google Calendar
 * source joins it for parallel testing before cutover. `getEventSource` resolves: explicit
 * name (from `/vc-bot-admin daily|weekly [source]`) wins; otherwise `env.EVENT_SOURCE`
 * (cutover = config flip); throws on unknown so a typo'd config var fails loudly (admin
 * pre-validates for a friendly message).
 */

export interface ReminderEvent {
  id: string;
  title: string;
  /** ISO-8601 UTC instant (adapters do the parsing/zone work). */
  startsAt: string;
  /** Optional end time, same format. */
  endsAt?: string | null;
  /** May contain HTML; rendered with htmlToMrkdwn. */
  description?: string | null;
  /** URL or free-text location (a non-URL renders as a "Location:" line, not a button). */
  joinLink?: string | null;
  /** Shown only in the event-admin mirror. */
  zoomHostCode?: string | null;
  /**
   * Per-event channel from the CMS. Currently unused — all public starting-soon messages
   * post to SLACK_EVENTS_CHANNEL_ID — but kept in the model in case routing returns.
   */
  slackChannelId?: string | null;
}

/** ISO range passed to the provider (computed in America/New_York). */
export interface EventRange {
  rangeStart: string;
  rangeEnd: string;
}

export interface EventSource {
  name: string;
  fetchEvents(range: EventRange): Promise<ReminderEvent[]>;
}

export type ReminderName = "daily" | "weekly";

const SOURCES = {
  cms: createCmsSource,
  google: createGoogleCalendarSource,
} satisfies Record<string, (env: Env) => EventSource>;

export type EventSourceName = keyof typeof SOURCES;
export const EVENT_SOURCE_NAMES = Object.keys(SOURCES) as EventSourceName[];

export function isEventSourceName(name: string): name is EventSourceName {
  return name in SOURCES;
}

export function getEventSource(env: Env, name?: string): EventSource {
  const resolved = name ?? env.EVENT_SOURCE ?? "cms";
  if (!isEventSourceName(resolved)) {
    throw new Error(
      `Unknown event source "${resolved}" (valid: ${EVENT_SOURCE_NAMES.join(", ")})`,
    );
  }
  return SOURCES[resolved](env);
}

const EASTERN = "America/New_York";

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
