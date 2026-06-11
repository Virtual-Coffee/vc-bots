import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { reminderRange } from "../src/bots/reminders/source";

// Thursday 2026-05-28, 12:00 UTC = 8:00 EDT (these run in real workerd, so this also
// verifies Luxon's America/New_York zone works on the ICU build there).
const NOW = Date.parse("2026-05-28T12:00:00Z");

describe("reminderRange", () => {
  it("daily is a rolling 24h window anchored at now, in Eastern time", () => {
    const { rangeStart, rangeEnd } = reminderRange("daily", NOW);
    expect(DateTime.fromISO(rangeStart, { setZone: true }).toMillis()).toBe(NOW);
    expect(DateTime.fromISO(rangeEnd, { setZone: true }).toMillis()).toBe(
      NOW + 24 * 60 * 60 * 1000,
    );
    expect(rangeStart).toContain("-04:00"); // EDT offset on this date
  });

  it("weekly runs from hour 0 today to one week out", () => {
    const { rangeStart, rangeEnd } = reminderRange("weekly", NOW);
    const start = DateTime.fromISO(rangeStart, { setZone: true });
    expect(start.hour).toBe(0);
    expect(start.toFormat("yyyy-MM-dd")).toBe("2026-05-28");
    expect(DateTime.fromISO(rangeEnd, { setZone: true }).toMillis()).toBe(
      NOW + 7 * 24 * 60 * 60 * 1000,
    );
  });

  it("weekly keeps the run's minutes (faithful old-bot quirk: only the hour is zeroed)", () => {
    const { rangeStart } = reminderRange("weekly", Date.parse("2026-05-28T12:34:56Z"));
    const start = DateTime.fromISO(rangeStart, { setZone: true });
    expect(start.hour).toBe(0);
    expect(start.minute).toBe(34);
  });
});
