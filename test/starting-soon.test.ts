import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReminder } from "../src/bots/reminders";
import { JOIN_EVENT_ACTION_ID } from "../src/bots/reminders/blocks";
import type { ReminderEvent } from "../src/bots/reminders/source";
import {
  buildStartingSoonAdminMessage,
  buildStartingSoonMessage,
} from "../src/bots/reminders/starting-soon";
import type { JoinInfo } from "../src/events";
import type { GoogleCalendarEvent } from "../src/google/calendar";
import { parseZoomMeetingId } from "../src/zoom/join-link";
import { type FetchRecorder, HOST_CODE, installFetchRecorder } from "./helpers/fetch-recorder";

const FALLBACK_CHANNEL = "C017WAKN883";

function reminderEvent(overrides: Partial<ReminderEvent> = {}): ReminderEvent {
  return {
    id: "1",
    title: "Lunch & Learn",
    startsAt: "2026-05-28T15:00:00.000Z",
    description: "Bring **questions**!",
    join: { kind: "zoom", url: "https://zoom.us/j/123", meetingId: "123", hostKey: "9876" },
    ...overrides,
  };
}

function json(blocks: unknown): string {
  return JSON.stringify(blocks);
}

// Thursday 2026-05-28, 12:00 UTC (8:00 EDT).
const NOW = Date.parse("2026-05-28T12:00:00Z");

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
  });
});

describe("sendReminder — daily, host key in the event-admin mirror", () => {
  it("shows the calendar's private hostCode only in the admin mirror", async () => {
    googleEvents = [evt("1", "2026-05-28T18:00:00", ZOOM_LOCATION)];
    await sendReminder("daily", env, NOW);

    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]?.get("blocks")).not.toContain("*Host Code:*"); // public
    expect(scheduled[1]?.get("blocks")).toContain(`*Host Code:* ${HOST_CODE}`); // admin
    expect(rec.callsTo("zoom.us")).toHaveLength(0); // the key comes from the calendar, not Zoom
  });

  it("omits the host code line for a non-Zoom Join Link without failing", async () => {
    googleEvents = [evt("1", "2026-05-28T18:00:00", "https://meet.google.com/abc-defg-hij")];
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: true, count: 1, scheduled: 1, source: "google" });

    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.get("blocks")).not.toContain("*Host Code:*");
  });

  it("a Zoom event without a hostCode is rejected upstream: no pair for it, siblings proceed", async () => {
    staleScheduled = [{ id: "QSTALE", channel_id: "COLD", post_at: NOW / 1000 + 3600 }];
    googleEvents = [
      evt("1", "2026-05-28T18:00:00", ZOOM_LOCATION),
      evt("2", "2026-05-28T20:00:00", ZOOM_LOCATION, null),
    ];
    const result = await sendReminder("daily", env, NOW);
    // The adapter dropped event 2 before the run saw it (docs/adr/0002).
    expect(result).toEqual({ posted: true, count: 1, scheduled: 1, source: "google" });

    expect(forms("/api/chat.deleteScheduledMessage")).toHaveLength(1);
    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.get("blocks")).toContain("Event 1");
    expect(scheduled[1]?.get("blocks")).not.toContain("Event 2");

    // The summary plus one #bot-log alert naming the rejected event.
    const posts = forms("/api/chat.postMessage");
    expect(posts).toHaveLength(2);
    const alert = posts.find((f) => f.get("channel") === env.SLACK_BOTLOG_CHANNEL_ID);
    expect(alert?.get("text")).toContain("calendar.event_rejected");
    expect(alert?.get("text")).toContain("Event 2");
    expect(posts.find((f) => f.get("channel") === env.SLACK_ANNOUNCEMENTS_CHANNEL_ID)?.get("text"))
      .not.toContain("Event 2");
  });
});

describe("buildStartingSoonMessage", () => {
  it("renders header, title with a Join Event button for http links, description, divider", () => {
    const { text, blocks } = buildStartingSoonMessage(reminderEvent());
    expect(text).toContain("Starting soon: Lunch & Learn");
    expect(blocks[0]).toMatchObject({ type: "header", text: { text: "⏰ Starting Soon:" } });
    expect(blocks[1]).toMatchObject({
      type: "section",
      accessory: {
        type: "button",
        action_id: JOIN_EVENT_ACTION_ID,
        value: "join_event_1",
        url: "https://zoom.us/j/123",
      },
    });
    expect(json(blocks)).toMatch(/<!date\^\d+\^\{date_long_pretty\} \{time\}\|/); // integer token
    expect(json(blocks)).toContain("*questions*"); // markdown → mrkdwn
    expect(json(blocks)).not.toContain("*Location:*");
    expect(blocks.at(-1)?.type).toBe("divider");
  });

  it("renders a free-text place as a Location section instead of a button", () => {
    const { blocks } = buildStartingSoonMessage(
      reminderEvent({ join: { kind: "place", text: "The VC Lounge" } }),
    );
    expect(json(blocks)).not.toContain('"button"');
    expect(json(blocks)).toContain("*Location:* The VC Lounge");
  });

  it("renders a non-Zoom url as a Join Event button with no Location section", () => {
    const { blocks } = buildStartingSoonMessage(
      reminderEvent({ join: { kind: "url", url: "https://meet.google.com/abc" } }),
    );
    expect(blocks[1]).toMatchObject({
      accessory: { type: "button", url: "https://meet.google.com/abc" },
    });
    expect(json(blocks)).not.toContain("*Location:*");
  });

  it("renders neither a button nor a Location section when there is no Join Link", () => {
    const { blocks } = buildStartingSoonMessage(reminderEvent({ join: { kind: "none" } }));
    expect(json(blocks)).not.toContain('"button"');
    expect(json(blocks)).not.toContain("*Location:*");
  });

  it("omits the description context when there is no description", () => {
    const { blocks } = buildStartingSoonMessage(reminderEvent({ description: null }));
    expect(blocks.filter((b) => b.type === "context")).toHaveLength(0);
  });

  it("renders Markdown links, emphasis, and lists as mrkdwn", () => {
    const { blocks } = buildStartingSoonMessage(
      reminderEvent({
        description: "See [the agenda](https://x.io/agenda) — _bring_ `code`\n\n- one\n- two",
      }),
    );
    const text = json(blocks.filter((b) => b.type === "context"));
    expect(text).toContain("<https://x.io/agenda|the agenda>");
    expect(text).toContain("_bring_");
    expect(text).toContain("`code`");
    expect(text).toContain("• ");
    expect(text).not.toContain("**");
    expect(text).not.toContain("](");
  });
});

describe("buildStartingSoonAdminMessage", () => {
  it("includes location, host code, and the target channel", () => {
    const { blocks } = buildStartingSoonAdminMessage(reminderEvent(), "C123");
    expect(json(blocks)).toContain("*Location:* https://zoom.us/j/123");
    expect(json(blocks)).toContain("*Host Code:* 9876");
    expect(json(blocks)).toContain("*Announcement posted to:* <#C123>");
  });

  it("shows a non-Zoom url as the location, with a button and no host code", () => {
    const join: JoinInfo = { kind: "url", url: "https://meet.google.com/abc" };
    const { blocks } = buildStartingSoonAdminMessage(reminderEvent({ join }), "C123");
    expect(blocks[1]).toMatchObject({ accessory: { type: "button", url: join.url } });
    expect(json(blocks)).toContain("*Location:* https://meet.google.com/abc");
    expect(json(blocks)).not.toContain("*Host Code:*");
  });

  it("shows a free-text place as the location, with no button and no host code", () => {
    const { blocks } = buildStartingSoonAdminMessage(
      reminderEvent({ join: { kind: "place", text: "The VC Lounge" } }),
      "C123",
    );
    expect(json(blocks)).not.toContain('"button"');
    expect(json(blocks)).toContain("*Location:* The VC Lounge");
    expect(json(blocks)).not.toContain("*Host Code:*");
  });

  it("omits the host code and location sections when there is no Join Link", () => {
    const { blocks } = buildStartingSoonAdminMessage(
      reminderEvent({ join: { kind: "none" } }),
      FALLBACK_CHANNEL,
    );
    expect(json(blocks)).not.toContain("*Host Code:*");
    expect(json(blocks)).not.toContain("*Location:*");
    expect(json(blocks)).toContain(`*Announcement posted to:* <#${FALLBACK_CHANNEL}>`);
  });
});
