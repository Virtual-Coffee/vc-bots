import { DateTime } from "luxon";
import type { Env } from "../../env";
import type { EventRange, ReminderEvent } from "../../events";
import { createGoogleCalendarPort } from "../../google/calendar";
import { createCmsSource } from "./sources/cms";

/**
 * Event-source registry for the reminders bot.
 *
 * Senders and Block Kit builders depend only on the source-agnostic model in `src/events.ts`
 * (re-exported here) — never on a provider's field names. Two sources: `google` (the
 * `CalendarPort` adapter's `listEvents`; the system of record once cut over, docs/adr/0001)
 * and `cms` (the interim default until then — docs/adr/0001 §Consequences, dated note). The
 * registry is the `EVENT_SOURCE` / admin `[source]` seam. `getEventSource` resolves: explicit
 * name (from `/vc-bot-admin daily|weekly [source]`) wins; otherwise `env.EVENT_SOURCE`; throws
 * on unknown so a typo'd config var fails loudly (admin pre-validates for a friendly message).
 */

export type { EventRange, ReminderEvent } from "../../events";

export interface EventSource {
  name: string;
  fetchEvents(range: EventRange): Promise<ReminderEvent[]>;
}

export type ReminderName = "daily" | "weekly";

const SOURCES = {
  google: (env: Env): EventSource => {
    const port = createGoogleCalendarPort(env);
    return { name: "google", fetchEvents: (range) => port.listEvents(range) };
  },
  cms: createCmsSource,
} satisfies Record<string, (env: Env) => EventSource>;

export type EventSourceName = keyof typeof SOURCES;
export const EVENT_SOURCE_NAMES = Object.keys(SOURCES) as EventSourceName[];

export function isEventSourceName(name: string): name is EventSourceName {
  // Own-property check: `in` would accept inherited names like "toString".
  return Object.prototype.hasOwnProperty.call(SOURCES, name);
}

/** The configured default source name (`EVENT_SOURCE`, "google" when unset) — the one seam for it. */
export function activeSourceName(env: Env): string {
  return env.EVENT_SOURCE ?? "google";
}

export function getEventSource(env: Env, name?: string): EventSource {
  const resolved = name ?? activeSourceName(env);
  if (!isEventSourceName(resolved)) {
    throw new Error(`Unknown event source "${resolved}" (valid: ${EVENT_SOURCE_NAMES.join(", ")})`);
  }
  return SOURCES[resolved](env);
}

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
