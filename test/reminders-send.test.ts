import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReminder } from "../src/bots/reminders";
import type { ReminderEvent } from "../src/events";
import { createCalendarFake } from "./helpers/calendar-fake";
import { type FetchRecorder, installFetchRecorder } from "./helpers/fetch-recorder";

// Thursday 2026-05-28, 12:00 UTC (8:00 EDT). Monday variant for the daily summary skip.
const NOW = Date.parse("2026-05-28T12:00:00Z");
const MONDAY_NOW = Date.parse("2026-05-25T12:00:00Z");

let rec: FetchRecorder;

beforeEach(() => {
  rec = installFetchRecorder({
    respond(call) {
      if (call.url.includes("/api/chat.scheduledMessages.list")) {
        return Response.json({ ok: true, scheduled_messages: [] });
      }
      return undefined;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** A timed `ReminderEvent` at `startUtc` (ISO, UTC) with no Join Link. */
function evt(id: string, startUtc: string): ReminderEvent {
  return {
    id,
    title: `Event ${id}`,
    startsAt: `${startUtc}.000Z`,
    join: { kind: "none" },
  };
}

function forms(fragment: string): URLSearchParams[] {
  return rec.callsTo(fragment).map((c) => rec.form(c));
}

describe("sendReminder — daily", () => {
  it("skips the summary on Mondays (weekly covers it) but still schedules", async () => {
    const calendar = createCalendarFake([evt("1", "2026-05-25T18:00:00")]);
    const result = await sendReminder("daily", env, MONDAY_NOW, calendar);
    expect(result).toEqual({
      posted: false,
      count: 1,
      scheduled: 1,
      reason: "monday",
    });

    expect(forms("/api/chat.scheduleMessage")).toHaveLength(2);
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });

  it("posts nothing when there are no events", async () => {
    const result = await sendReminder("daily", env, NOW, createCalendarFake());
    expect(result).toEqual({
      posted: false,
      count: 0,
      scheduled: 0,
      reason: "no-events",
    });
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });
});

describe("sendReminder — weekly", () => {
  it("posts one summary to the announcements channel and schedules nothing", async () => {
    const calendar = createCalendarFake([
      evt("1", "2026-05-28T18:00:00"),
      evt("2", "2026-05-30T15:00:00"),
    ]);
    const result = await sendReminder("weekly", env, NOW, calendar);
    expect(result).toEqual({ posted: true, count: 2 });

    const posts = forms("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get("channel")).toBe(env.SLACK_ANNOUNCEMENTS_CHANNEL_ID);
    expect(posts[0]?.get("text")).toContain("This weeks events are:");
    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
    expect(forms("/api/chat.scheduledMessages.list")).toHaveLength(0);
  });

  it("posts nothing when the week is empty", async () => {
    const result = await sendReminder("weekly", env, NOW, createCalendarFake());
    expect(result).toEqual({ posted: false, count: 0, reason: "no-events" });
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });
});
