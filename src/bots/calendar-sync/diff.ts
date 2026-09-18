import { DateTime } from "luxon";
import type { InvalidEventReason, ReminderEvent } from "../../events";
import type { CalendarEventLookup } from "../../google/calendar";
import type { ReminderMessage } from "../reminders/blocks";
import { buildCancellationMessage, buildRescheduleMessage } from "../reminders/blocks";

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
  /** Notices in delivery order: departed events (snapshot order), then in-window reschedules. */
  notices: ReminderMessage[];
  cancellations: number;
  reschedules: number;
  /** Departed events still live but unannounceable — the caller logs them; no notice. */
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
 * Diff the live window against the snapshot into notices.
 *
 * - Departed (in `prior`, not in `current`, announced start still upcoming), by its lookup:
 *   `cancelled` → cancellation notice; `live` → reschedule notice to the new start (an
 *   out-of-window move); `all-day` → nothing (no timed slot to correct to); `invalid` →
 *   nothing, reported in `invalid` (the adapter already alerted #bot-log). A departed id with
 *   no lookup shouldn't happen (`departedUpcoming` names exactly the ids to fetch) — treated as
 *   no notice.
 * - In both, announced start still upcoming, start changed → reschedule notice.
 * - New ids → nothing: the scheduling reconcile handles them.
 *
 * Departed notices come first (in `prior` order), then in-window reschedules (in `current`
 * order). Both notice kinds for a departed event carry no Join Link — the snapshot doesn't
 * keep one.
 */
export function diffSnapshot(
  prior: ReadonlyMap<string, SnapshotEntry>,
  current: ReadonlyMap<string, ReminderEvent>,
  lookups: ReadonlyMap<string, CalendarEventLookup>,
  nowMs: number,
): SnapshotDiff {
  const notices: ReminderMessage[] = [];
  const invalid: SnapshotDiff["invalid"] = [];
  let cancellations = 0;
  let reschedules = 0;

  for (const id of departedUpcoming(prior, current, nowMs)) {
    const snap = prior.get(id)!;
    const lookup = lookups.get(id);
    switch (lookup?.kind) {
      case "cancelled": {
        const reconstructed: ReminderEvent = {
          id,
          title: snap.title ?? "(event)",
          startsAt: snap.startsAt,
          join: { kind: "none" },
        };
        notices.push(buildCancellationMessage(reconstructed));
        cancellations += 1;
        break;
      }
      case "live": {
        const moved: ReminderEvent = {
          id,
          title: snap.title ?? "(event)",
          startsAt: lookup.event.startsAt,
          join: { kind: "none" },
        };
        notices.push(buildRescheduleMessage(moved, snap.startsAt));
        reschedules += 1;
        break;
      }
      case "invalid":
        invalid.push({ id, reason: lookup.reason });
        break;
      case "all-day":
      case undefined:
        break;
    }
  }

  for (const [id, event] of current) {
    const snap = prior.get(id);
    if (!snap) continue;
    if (!isFuture(snap.startsAt, nowMs)) continue;
    if (event.startsAt !== snap.startsAt) {
      notices.push(buildRescheduleMessage(event, snap.startsAt));
      reschedules += 1;
    }
  }

  return { notices, cancellations, reschedules, invalid };
}
