import { DateTime } from "luxon";
import type { EventRange } from "../../events";

/**
 * Reminder windows. Events come from the Google Calendar adapter (`CalendarPort.listEvents`,
 * docs/adr/0011); senders and Block Kit builders see only the model in `src/events.ts`
 * (re-exported here, docs/adr/0001).
 */

export type { EventRange, ReminderEvent } from "../../events";

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
