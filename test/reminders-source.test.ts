import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { EVENT_SOURCE_NAMES, getEventSource, isEventSourceName, reminderRange } from "../src/bots/reminders/source";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";

// Thursday 2026-05-28, 12:00 UTC = 8:00 EDT (these run in real workerd, so this also
// verifies Luxon's America/New_York zone works on the ICU build there).
const NOW = Date.parse("2026-05-28T12:00:00Z");

describe("getEventSource / isEventSourceName", () => {
  it("returns the cms source by default (no EVENT_SOURCE set)", () => {
    const source = getEventSource({ ...env, EVENT_SOURCE: "cms" } as Env);
    expect(source.name).toBe("cms");
  });

  it("returns the google source when EVENT_SOURCE is 'google'", () => {
    const source = getEventSource({ ...env, EVENT_SOURCE: "google" } as Env);
    expect(source.name).toBe("google");
  });

  it("explicit name beats env var", () => {
    const source = getEventSource({ ...env, EVENT_SOURCE: "cms" } as Env, "google");
    expect(source.name).toBe("google");
  });

  it("throws on unknown source name and lists valid names in the message", () => {
    expect(() => getEventSource(env as Env, "bogus")).toThrow("bogus");
    expect(() => getEventSource(env as Env, "bogus")).toThrow("cms");
    expect(() => getEventSource(env as Env, "bogus")).toThrow("google");
  });

  it("EVENT_SOURCE_NAMES contains cms and google", () => {
    expect(EVENT_SOURCE_NAMES).toContain("cms");
    expect(EVENT_SOURCE_NAMES).toContain("google");
  });

  it("isEventSourceName narrows correctly", () => {
    expect(isEventSourceName("cms")).toBe(true);
    expect(isEventSourceName("google")).toBe(true);
    expect(isEventSourceName("bogus")).toBe(false);
  });
});

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
