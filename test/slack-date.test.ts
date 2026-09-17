import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { dateToken } from "../src/slack/date";

// 2026-05-28T15:00:00.750Z — a fractional-second instant, so flooring is observable.
const INSTANT_MS = 1_780_326_000_750;
const INSTANT_S = 1_780_326_000;

describe("dateToken", () => {
  it("floors the epoch to integer seconds (Slack drops the token otherwise)", () => {
    const dt = DateTime.fromMillis(INSTANT_MS, { zone: "utc" });
    expect(dateToken(dt, "{time}", "t")).toMatch(new RegExp(`^<!date\\^${INSTANT_S}\\^`));
    expect(dateToken(dt, "{time}", "t")).not.toContain(".");
  });

  it("keeps the Slack format verbatim between the carets", () => {
    const dt = DateTime.fromMillis(INSTANT_MS, { zone: "utc" });
    expect(dateToken(dt, "{date_long_pretty} {time}", "t")).toContain(
      "^{date_long_pretty} {time}|",
    );
  });

  it("renders the fallback in the DateTime's own zone", () => {
    const utc = DateTime.fromMillis(INSTANT_MS, { zone: "utc" });
    const ny = utc.setZone("America/New_York");

    const utcToken = dateToken(utc, "{time}", "t ZZZZ");
    const nyToken = dateToken(ny, "{time}", "t ZZZZ");

    // Same instant, same epoch…
    expect(utcToken.split("^")[1]).toBe(nyToken.split("^")[1]);
    // …but the fallback reads in whatever zone the caller anchored the DateTime to.
    expect(utcToken).toContain("|3:00 PM UTC>");
    expect(nyToken).toContain("|11:00 AM EDT>");
  });
});
