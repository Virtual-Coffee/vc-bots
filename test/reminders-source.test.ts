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

  it("weekly is the current Mon–Sun ISO week, anchored to Monday 00:00 Eastern (not the run day)", () => {
    // NOW is a Thursday; the window must start on that week's Monday (2026-05-25) and end on the
    // next Monday (2026-06-01), regardless of which day inside the week it's computed.
    const { rangeStart, rangeEnd } = reminderRange("weekly", NOW);
    const start = DateTime.fromISO(rangeStart, { setZone: true });
    const end = DateTime.fromISO(rangeEnd, { setZone: true });
    expect(start.weekday).toBe(1); // Monday
    expect(start.hour).toBe(0);
    expect(start.minute).toBe(0);
    expect(start.toFormat("yyyy-MM-dd")).toBe("2026-05-25");
    expect(rangeStart).toContain("-04:00"); // EDT offset on this date
    expect(end.weekday).toBe(1); // next Monday
    expect(end.hour).toBe(0);
    expect(end.toFormat("yyyy-MM-dd")).toBe("2026-06-01");
  });

  it("weekly is stable across the week — a Sunday run yields the same Monday-anchored window", () => {
    // Sunday 2026-05-31 still belongs to the ISO week starting Monday 2026-05-25.
    const { rangeStart, rangeEnd } = reminderRange("weekly", Date.parse("2026-05-31T18:00:00Z"));
    expect(DateTime.fromISO(rangeStart, { setZone: true }).toFormat("yyyy-MM-dd")).toBe(
      "2026-05-25",
    );
    expect(DateTime.fromISO(rangeEnd, { setZone: true }).toFormat("yyyy-MM-dd")).toBe("2026-06-01");
  });
});
