import { DateTime } from "luxon";
import type { Env } from "../../env";
import { createCmsSource } from "./sources/cms";

/**
 * Source-agnostic event model for the reminders bot.
 *
 * Senders and Block Kit builders depend only on these types — never on a provider's field
 * names. The CMS (Craft + Solspace Calendar) is the first `EventSource`; a Google Calendar
 * source will join it (~late June 2026) and the two must be able to run in parallel for
 * testing before cutover.
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

/**
 * The active source. When the Google Calendar source lands this becomes a registry
 * (e.g. `getEventSource(env, name?)`) so `/vc-bot-admin` can preview a named source and
 * both can run in parallel for testing without touching prod channels.
 */
export function getEventSource(env: Env): EventSource {
  return createCmsSource(env);
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
  // Weekly quirk kept from the old bot: set({hour: 0}) zeroes only the hour, keeping the
  // run's minutes/seconds. Harmless — the window just starts shortly after midnight.
  return { rangeStart: toIso(now.set({ hour: 0 })), rangeEnd: toIso(now.plus({ weeks: 1 })) };
}

function toIso(dt: DateTime): string {
  // fromMillis with a fixed zone is always valid; the fallback keeps TS strictness honest.
  return dt.toISO() ?? new Date(dt.toMillis()).toISOString();
}
