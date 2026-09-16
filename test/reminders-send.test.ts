import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReminder } from "../src/bots/reminders";
import type { GoogleCalendarEvent } from "../src/google/calendar";
import { parseZoomMeetingId } from "../src/zoom/join-link";
import { type FetchRecorder, HOST_CODE, installFetchRecorder } from "./helpers/fetch-recorder";

// Thursday 2026-05-28, 12:00 UTC (8:00 EDT). Monday variant for the daily summary skip.
const NOW = Date.parse("2026-05-28T12:00:00Z");
const MONDAY_NOW = Date.parse("2026-05-25T12:00:00Z");

const ZOOM_LOCATION = "https://us02web.zoom.us/j/81323022832?pwd=abc123";

let rec: FetchRecorder;
let googleEvents: GoogleCalendarEvent[];
let staleScheduled: Array<{ id: string; channel_id: string; post_at: number }>;

beforeEach(() => {
  googleEvents = [];
  staleScheduled = [];
  rec = installFetchRecorder({
    googleEvents: () => googleEvents,
    respond(call) {
      if (call.url.includes("/api/chat.scheduledMessages.list")) {
        return Response.json({ ok: true, scheduled_messages: staleScheduled });
      }
      return undefined;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * A timed calendar event at `startUtc` (ISO, UTC); `location` is the Join Link. A Zoom Join
 * Link carries the `HOST_CODE` private property unless `hostCode` overrides it (null = none).
 */
function evt(
  id: string,
  startUtc: string,
  location?: string,
  hostCode: string | null = location && parseZoomMeetingId(location) ? HOST_CODE : null,
): GoogleCalendarEvent {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: `${startUtc}Z` },
    end: { dateTime: `${startUtc}Z` },
    location,
    ...(hostCode === null ? {} : { extendedProperties: { private: { hostCode } } }),
  };
}

function forms(fragment: string): URLSearchParams[] {
  return rec.callsTo(fragment).map((c) => rec.form(c));
}

describe("sendReminder — daily", () => {
  it("skips the summary on Mondays (weekly covers it) but still schedules", async () => {
    googleEvents = [evt("1", "2026-05-25T18:00:00")];
    const result = await sendReminder("daily", env, MONDAY_NOW);
    expect(result).toEqual({ posted: false, count: 1, scheduled: 1, reason: "monday", source: "google" });

    expect(forms("/api/chat.scheduleMessage")).toHaveLength(2);
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });

  it("posts nothing when there are no events", async () => {
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: false, count: 0, scheduled: 0, reason: "no-events", source: "google" });
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });
});

describe("sendReminder — weekly", () => {
  it("posts one summary to the announcements channel and schedules nothing", async () => {
    googleEvents = [evt("1", "2026-05-28T18:00:00"), evt("2", "2026-05-30T15:00:00", ZOOM_LOCATION)];
    const result = await sendReminder("weekly", env, NOW);
    expect(result).toEqual({ posted: true, count: 2, source: "google" });

    const posts = forms("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get("channel")).toBe(env.SLACK_ANNOUNCEMENTS_CHANNEL_ID);
    expect(posts[0]?.get("text")).toContain("This weeks events are:");
    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
    expect(forms("/api/chat.scheduledMessages.list")).toHaveLength(0);
  });

  it("posts nothing when the week is empty", async () => {
    const result = await sendReminder("weekly", env, NOW);
    expect(result).toEqual({ posted: false, count: 0, reason: "no-events", source: "google" });
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });
});
