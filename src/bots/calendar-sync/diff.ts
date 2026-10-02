import { DateTime } from "luxon";
import type { CalendarChange, InvalidEventReason, ReminderEvent } from "../../events";
import type { MappedEvent } from "../../google/calendar";

/**
 * The snapshot diff behind `CalendarSync.processNotification`, kept pure (no I/O, no DO) so the
 * rules are unit-testable with plain maps. The DO reads the snapshot, lists the live window,
 * fetches the single-event lookups `departedUpcoming` asks for, and hands everything to
 * `diffSnapshot`.
 *
 * Only a change to an event whose *announced* start is still upcoming is announced. A change to
 * an event that has already begun/passed needs no correction; and because the window is the
 * current Mon–Sun announced week (Change 1), next week's events aren't in the snapshot at all,
 * so they never produce a diff until their own Monday summary goes out.
 */

/** One row of the last-known snapshot: what was announced for the event. */
export interface SnapshotEntry {
  id: string;
  startsAt: string;
  title: string | null;
}

export interface SnapshotDiff {
  /** Changes in delivery order: departed events (snapshot order), then in-window reschedules. */
  changes: CalendarChange[];
  /** Departed events still live but unannounceable — the caller logs them; no change. */
  invalid: Array<{ id: string; reason: InvalidEventReason }>;
}

function isFuture(iso: string, nowMs: number): boolean {
  return DateTime.fromISO(iso, { setZone: true }).toMillis() > nowMs;
}

/**
 * Snapshot ids no longer in the live window whose announced start is still upcoming — the ones
 * that need a single-event lookup to tell a cancellation from a reschedule out of the window.
 * An already-passed slot needs no correction, so it's skipped without a lookup.
 */
export function departedUpcoming(
  prior: ReadonlyMap<string, SnapshotEntry>,
  current: ReadonlyMap<string, ReminderEvent>,
  nowMs: number,
): string[] {
  const ids: string[] = [];
  for (const [id, snap] of prior) {
    if (current.has(id)) continue;
    if (!isFuture(snap.startsAt, nowMs)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Diff the live window against the snapshot into changes.
 *
 * - Departed (in `prior`, not in `current`, announced start still upcoming), by its lookup:
 *   `skipped` / `cancelled` → `cancelled` change; `event` → `rescheduled` change to the new
 *   start (an out-of-window move); `skipped` for `all-day` / `bad-start` → nothing (no timed slot
 *   to correct to; the adapter already warned about the unparseable start); `invalid` → nothing, reported in
 *   `invalid` (the adapter already alerted #bot-log). A departed id with no lookup shouldn't
 *   happen (`departedUpcoming` names exactly the ids to fetch) — treated as no change.
 * - In both, announced start still upcoming, start changed → `rescheduled` change.
 * - New ids → nothing: the starting-soon sync handles them.
 *
 * Departed changes come first (in `prior` order), then in-window reschedules (in `current`
 * order). Both change kinds for a departed event carry no Join Link — the snapshot doesn't
 * keep one.
 */
export function diffSnapshot(
  prior: ReadonlyMap<string, SnapshotEntry>,
  current: ReadonlyMap<string, ReminderEvent>,
  lookups: ReadonlyMap<string, MappedEvent>,
  nowMs: number,
): SnapshotDiff {
  const changes: CalendarChange[] = [];
  const invalid: SnapshotDiff["invalid"] = [];

  for (const id of departedUpcoming(prior, current, nowMs)) {
    const snap = prior.get(id)!;
    const lookup = lookups.get(id);
    switch (lookup?.kind) {
      case "skipped": {
        // All-day / bad-start: no timed slot to correct to — nothing.
        if (lookup.reason !== "cancelled") break;
        const reconstructed: ReminderEvent = {
          id,
          title: snap.title ?? "(event)",
          startsAt: snap.startsAt,
          join: { kind: "none" },
        };
        changes.push({ kind: "cancelled", event: reconstructed });
        break;
      }
      case "event": {
        const moved: ReminderEvent = {
          id,
          title: snap.title ?? "(event)",
          startsAt: lookup.event.startsAt,
          join: { kind: "none" },
        };
        changes.push({ kind: "rescheduled", event: moved, from: snap.startsAt });
        break;
      }
      case "invalid":
        invalid.push({ id, reason: lookup.reason });
        break;
      case undefined:
        break;
    }
  }

  for (const [id, event] of current) {
    const snap = prior.get(id);
    if (!snap) continue;
    if (!isFuture(snap.startsAt, nowMs)) continue;
    if (event.startsAt !== snap.startsAt) {
      changes.push({ kind: "rescheduled", event, from: snap.startsAt });
    }
  }

  return { changes, invalid };
}
