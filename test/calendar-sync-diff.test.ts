import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { departedUpcoming, diffSnapshot, type SnapshotEntry } from "../src/bots/calendar-sync/diff";
import type { ReminderEvent } from "../src/events";
import type { MappedEvent } from "../src/google/calendar";

/**
 * The snapshot diff rules (`src/bots/calendar-sync/diff.ts`) against plain maps — no DO, no
 * calendar, no Slack. `test/calendar-sync-do.test.ts` keeps the I/O around them (lookup calls,
 * three-channel delivery, snapshot commit order).
 */

// Same fixed "now" as the DO suite: Wednesday 2026-06-17, 12:00 EDT. `at(+48h)`/`at(+72h)` are
// Fri/Sat (in-window, future), `at(-24h)` is Tuesday (past), `at(+6d)` is next Tuesday.
const NOW = Date.parse("2026-06-17T16:00:00Z");
const NOW_DT = DateTime.fromMillis(NOW, { zone: "America/New_York" });

/** An ISO instant `hours` from the fixed `NOW` (negative = past), Eastern offset. */
function at(hours: number): string {
  return NOW_DT.plus({ hours }).set({ second: 0, millisecond: 0 }).toISO()!;
}

function timedEvent(id: string, startsAt: string, title = "Event"): ReminderEvent {
  return { id, title, startsAt, join: { kind: "none" } };
}

function snapshot(...events: ReminderEvent[]): Map<string, SnapshotEntry> {
  return new Map(events.map((e) => [e.id, { id: e.id, startsAt: e.startsAt, title: e.title }]));
}
function live(...events: ReminderEvent[]): Map<string, ReminderEvent> {
  return new Map(events.map((e) => [e.id, e]));
}
function lookups(entries: Record<string, MappedEvent>): Map<string, MappedEvent> {
  return new Map(Object.entries(entries));
}

const NONE = new Map<string, MappedEvent>();

describe("departedUpcoming", () => {
  it("names the snapshot ids that left the window with an upcoming announced start", () => {
    const prior = snapshot(
      timedEvent("gone", at(48)),
      timedEvent("stays", at(72)),
      timedEvent("past", at(-24)),
    );
    expect(departedUpcoming(prior, live(timedEvent("stays", at(72))), NOW)).toEqual(["gone"]);
  });

  it("does not name an event whose announced start already passed (no lookup needed)", () => {
    expect(departedUpcoming(snapshot(timedEvent("evt-1", at(-24))), live(), NOW)).toEqual([]);
  });
});

describe("diffSnapshot", () => {
  it("a departed event the lookup reports cancelled → one cancelled change", () => {
    const prior = snapshot(timedEvent("evt-1", at(48), "Coffee"));
    const diff = diffSnapshot(
      prior,
      live(),
      lookups({ "evt-1": { kind: "skipped", reason: "cancelled" } }),
      NOW,
    );

    expect(diff.changes).toEqual([
      { kind: "cancelled", event: timedEvent("evt-1", at(48), "Coffee") },
    ]);
    expect(diff.invalid).toEqual([]);
  });

  it("rebuilds the departed event from the snapshot: `(event)` for a missing title, no Join Link", () => {
    const prior = new Map<string, SnapshotEntry>([
      ["evt-1", { id: "evt-1", startsAt: at(48), title: null }],
    ]);
    const diff = diffSnapshot(
      prior,
      live(),
      lookups({ "evt-1": { kind: "skipped", reason: "cancelled" } }),
      NOW,
    );

    expect(diff.changes).toEqual([
      {
        kind: "cancelled",
        event: { id: "evt-1", title: "(event)", startsAt: at(48), join: { kind: "none" } },
      },
    ]);
  });

  it("a departed event that is live elsewhere (moved out of the week) → one rescheduled change", () => {
    const prior = snapshot(timedEvent("evt-1", at(48), "Coffee"));
    const moved = timedEvent("evt-1", at(24 * 6), "Renamed");
    const found = lookups({ "evt-1": { kind: "event", event: moved } });
    const diff = diffSnapshot(prior, live(), found, NOW);

    // Rebuilt from the snapshot title with the looked-up start, not the live event itself.
    expect(diff.changes).toEqual([
      {
        kind: "rescheduled",
        event: { id: "evt-1", title: "Coffee", startsAt: at(24 * 6), join: { kind: "none" } },
        from: at(48),
      },
    ]);
  });

  it("an in-window start change → one rescheduled change", () => {
    const prior = snapshot(timedEvent("evt-1", at(48)));
    const event = timedEvent("evt-1", at(72));
    const diff = diffSnapshot(prior, live(event), NONE, NOW);

    expect(diff.changes).toEqual([{ kind: "rescheduled", event, from: at(48) }]);
  });

  it("a departed event that turned all-day → nothing (no timed slot to correct to)", () => {
    const prior = snapshot(timedEvent("evt-1", at(48)));
    const diff = diffSnapshot(
      prior,
      live(),
      lookups({ "evt-1": { kind: "skipped", reason: "all-day" } }),
      NOW,
    );
    expect(diff).toEqual({ changes: [], invalid: [] });
  });

  it("a departed event whose start became unparseable → nothing (bad-start, not a reschedule)", () => {
    const prior = snapshot(timedEvent("evt-1", at(48)));
    const diff = diffSnapshot(
      prior,
      live(),
      lookups({ "evt-1": { kind: "skipped", reason: "bad-start" } }),
      NOW,
    );
    expect(diff).toEqual({ changes: [], invalid: [] });
  });

  it("a departed event that turned invalid → no change, reported in `invalid`", () => {
    const prior = snapshot(timedEvent("evt-1", at(48)));
    const diff = diffSnapshot(
      prior,
      live(),
      lookups({ "evt-1": { kind: "invalid", reason: "zoom-no-host-key" } }),
      NOW,
    );
    expect(diff.changes).toEqual([]);
    expect(diff.invalid).toEqual([{ id: "evt-1", reason: "zoom-no-host-key" }]);
  });

  it("a departed id with no lookup → nothing (departedUpcoming names what to fetch)", () => {
    const prior = snapshot(timedEvent("evt-1", at(48)));
    const diff = diffSnapshot(prior, live(), NONE, NOW);
    expect(diff).toEqual({ changes: [], invalid: [] });
  });

  it("a change to an event whose announced start already passed → nothing", () => {
    const prior = snapshot(timedEvent("evt-1", at(-24)), timedEvent("evt-2", at(-24)));
    const diff = diffSnapshot(
      prior,
      live(timedEvent("evt-2", at(48))), // evt-1 gone, evt-2 moved — both already announced past
      lookups({ "evt-1": { kind: "skipped", reason: "cancelled" } }),
      NOW,
    );
    expect(diff).toEqual({ changes: [], invalid: [] });
  });

  it("an unchanged window → nothing", () => {
    const evt = timedEvent("evt-1", at(48));
    const diff = diffSnapshot(snapshot(evt), live(evt), NONE, NOW);
    expect(diff).toEqual({ changes: [], invalid: [] });
  });

  it("a new id → nothing (the starting-soon sync handles it)", () => {
    const diff = diffSnapshot(snapshot(), live(timedEvent("new", at(48))), NONE, NOW);
    expect(diff).toEqual({ changes: [], invalid: [] });
  });

  it("orders changes: departed events in snapshot order, then in-window reschedules in live order", () => {
    const prior = snapshot(
      timedEvent("moved-b", at(30), "Moved B"),
      timedEvent("gone-a", at(48), "Gone A"),
      timedEvent("moved-a", at(50), "Moved A"),
      timedEvent("gone-b", at(52), "Gone B"),
    );
    const current = live(
      timedEvent("moved-a", at(72), "Moved A"),
      timedEvent("moved-b", at(74), "Moved B"),
    );
    const diff = diffSnapshot(
      prior,
      current,
      lookups({
        "gone-a": { kind: "skipped", reason: "cancelled" },
        "gone-b": { kind: "skipped", reason: "cancelled" },
      }),
      NOW,
    );

    expect(diff.changes.map((c) => [c.kind, c.event.id])).toEqual([
      ["cancelled", "gone-a"],
      ["cancelled", "gone-b"],
      ["rescheduled", "moved-a"],
      ["rescheduled", "moved-b"],
    ]);
  });
});
