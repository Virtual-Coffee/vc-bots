import { describe, expect, it } from "vitest";
import type { CmsEvent } from "../src/bots/reminders/cms";
import { filterUpcoming } from "../src/bots/reminders/cms";

const NOW = Date.parse("2026-05-28T12:00:00Z");

function evt(id: string, startsAt: string): CmsEvent {
  return { id, title: `Event ${id}`, startsAt };
}

describe("filterUpcoming", () => {
  const events = [
    evt("past", "2026-05-28T11:00:00Z"), // 1h ago
    evt("in30m", "2026-05-28T12:30:00Z"), // within the hour
    evt("in3h", "2026-05-28T15:00:00Z"), // today
    evt("in2d", "2026-05-30T12:00:00Z"), // this week
    evt("in10d", "2026-06-07T12:00:00Z"), // beyond a week
    evt("bad", "not-a-date"),
  ];

  it("keeps only events starting within the next hour", () => {
    const ids = filterUpcoming(events, 1, NOW).map((e) => e.id);
    expect(ids).toEqual(["in30m"]);
  });

  it("keeps events within the next 24h", () => {
    const ids = filterUpcoming(events, 24, NOW).map((e) => e.id);
    expect(ids).toEqual(["in30m", "in3h"]);
  });

  it("keeps events within the next week, sorted by start time", () => {
    const ids = filterUpcoming(events, 24 * 7, NOW).map((e) => e.id);
    expect(ids).toEqual(["in30m", "in3h", "in2d"]);
  });

  it("excludes past events and unparseable dates", () => {
    const ids = filterUpcoming(events, 24 * 30, NOW).map((e) => e.id);
    expect(ids).not.toContain("past");
    expect(ids).not.toContain("bad");
  });
});
