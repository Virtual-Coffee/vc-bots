import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReminder } from "../src/bots/reminders";
import type { GoogleCalendarEvent } from "../src/bots/reminders/sources/google-calendar";
import { resetGoogleTokenCacheForTests } from "../src/google/auth";
import {
  type FetchRecorder,
  installFetchRecorder,
  ZOOM_HOST_KEY,
} from "./helpers/fetch-recorder";

// Thursday 2026-05-28, 12:00 UTC (8:00 EDT). Monday variant for the daily summary skip.
const NOW = Date.parse("2026-05-28T12:00:00Z");
const MONDAY_NOW = Date.parse("2026-05-25T12:00:00Z");

const ZOOM_LOCATION = "https://us02web.zoom.us/j/81323022832?pwd=abc123";

let rec: FetchRecorder;
let googleEvents: GoogleCalendarEvent[];
let staleScheduled: Array<{ id: string; channel_id: string; post_at: number }>;

beforeEach(() => {
  resetGoogleTokenCacheForTests();
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

/** A timed calendar event at `startUtc` (ISO, UTC); `location` is the Join Link. */
function evt(id: string, startUtc: string, location?: string): GoogleCalendarEvent {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: `${startUtc}Z` },
    end: { dateTime: `${startUtc}Z` },
    location,
  };
}

function forms(fragment: string): URLSearchParams[] {
  return rec.callsTo(fragment).map((c) => rec.form(c));
}

describe("sendReminder — daily", () => {
  it("schedules a public + admin pair per event and posts the summary", async () => {
    googleEvents = [
      evt("1", "2026-05-28T18:00:00"), // +6h
      evt("2", "2026-05-28T20:00:00"), // +8h
    ];
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: true, count: 2, scheduled: 2, source: "google" });

    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(4);
    expect(scheduled.map((f) => f.get("channel"))).toEqual([
      env.SLACK_EVENTS_CHANNEL_ID,
      env.SLACK_EVENTADMIN_CHANNEL_ID,
      env.SLACK_EVENTS_CHANNEL_ID,
      env.SLACK_EVENTADMIN_CHANNEL_ID,
    ]);
    // post_at = start − 10 min
    expect(scheduled[0]?.get("post_at")).toBe(
      String(Date.parse("2026-05-28T18:00:00Z") / 1000 - 600),
    );
    expect(scheduled[0]?.get("unfurl_links")).toBe("false");

    const posts = forms("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get("channel")).toBe(env.SLACK_ANNOUNCEMENTS_CHANNEL_ID);
    expect(posts[0]?.get("text")).toContain("Today's events are:");
  });

  it("reconciles: deletes previously scheduled messages in the window before re-scheduling", async () => {
    staleScheduled = [{ id: "QSTALE", channel_id: "COLD", post_at: NOW / 1000 + 3600 }];
    googleEvents = [evt("1", "2026-05-28T18:00:00")];
    await sendReminder("daily", env, NOW);

    const deletes = forms("/api/chat.deleteScheduledMessage");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.get("channel")).toBe("COLD");
    expect(deletes[0]?.get("scheduled_message_id")).toBe("QSTALE");
  });

  it("posts immediately when the event starts in under 10 minutes", async () => {
    googleEvents = [evt("1", "2026-05-28T12:05:00")]; // +5 min — the −10min slot already passed
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: true, count: 1, scheduled: 1, source: "google" });

    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
    const posts = forms("/api/chat.postMessage");
    // starting-soon pair (public + admin) + the daily summary
    expect(posts).toHaveLength(3);
    expect(posts[0]?.get("text")).toContain("Starting soon:");
  });

  it("skips already-started events but still posts the summary", async () => {
    googleEvents = [evt("1", "2026-05-28T11:00:00", ZOOM_LOCATION)]; // started 1h ago
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: true, count: 1, scheduled: 0, source: "google" });

    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
    expect(forms("/api/chat.postMessage")).toHaveLength(1); // summary only
    expect(rec.callsTo("zoom.us")).toHaveLength(0); // nothing announced → no host-key lookups
  });

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

describe("sendReminder — daily, host key in the event-admin mirror", () => {
  it("resolves the Zoom host key from the Join Link and shows it only in the admin mirror", async () => {
    googleEvents = [evt("1", "2026-05-28T18:00:00", ZOOM_LOCATION)];
    await sendReminder("daily", env, NOW);

    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]?.get("blocks")).not.toContain("*Host Code:*"); // public
    expect(scheduled[1]?.get("blocks")).toContain(`*Host Code:* ${ZOOM_HOST_KEY}`); // admin

    // meeting id parsed from the Join Link → meeting GET → user GET
    expect(rec.callsTo("api.zoom.us/v2/meetings/81323022832")).toHaveLength(1);
    expect(rec.callsTo("api.zoom.us/v2/users/HOST1")).toHaveLength(1);
  });

  it("omits the host code line for a non-Zoom Join Link and makes no Zoom calls", async () => {
    googleEvents = [evt("1", "2026-05-28T18:00:00", "https://meet.google.com/abc-defg-hij")];
    await sendReminder("daily", env, NOW);

    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.get("blocks")).not.toContain("*Host Code:*");
    expect(rec.callsTo("zoom.us")).toHaveLength(0);
  });

  it("fails the run when Zoom errors", async () => {
    googleEvents = [evt("1", "2026-05-28T18:00:00", ZOOM_LOCATION)];
    rec.respondWith((call) =>
      call.url.includes("api.zoom.us/v2/meetings/")
        ? new Response("boom", { status: 500 })
        : undefined,
    );
    await expect(sendReminder("daily", env, NOW)).rejects.toThrow("Zoom get-meeting failed: 500");
    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
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
    expect(rec.callsTo("zoom.us")).toHaveLength(0); // the weekly never needs a host key
  });

  it("posts nothing when the week is empty", async () => {
    const result = await sendReminder("weekly", env, NOW);
    expect(result).toEqual({ posted: false, count: 0, reason: "no-events", source: "google" });
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });
});
