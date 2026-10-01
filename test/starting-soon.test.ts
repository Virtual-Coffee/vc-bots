import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReminder } from "../src/bots/reminders";
import { JOIN_EVENT_ACTION_ID } from "../src/bots/reminders/blocks";
import {
  buildStartingSoonAdminMessage,
  buildStartingSoonMessage,
  syncStartingSoon,
} from "../src/bots/reminders/starting-soon";
import { type JoinInfo, type ReminderEvent, reminderRange } from "../src/events";
import type { GoogleCalendarEvent } from "../src/google/calendar";
import { parseZoomMeetingId } from "../src/zoom/join-link";
import { createCalendarFake } from "./helpers/calendar-fake";
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
let scheduledPages: Array<Array<{ id: string; channel_id: string; post_at: number }>> | null;

beforeEach(() => {
  googleEvents = [];
  staleScheduled = [];
  scheduledPages = null;
  rec = installFetchRecorder({
    googleEvents: () => googleEvents,
    respond(call) {
      if (call.url.includes("/api/chat.scheduledMessages.list")) {
        if (scheduledPages) {
          const page = scheduledPages.shift() ?? [];
          return Response.json({
            ok: true,
            scheduled_messages: page,
            response_metadata: { next_cursor: scheduledPages.length > 0 ? "next" : "" },
          });
        }
        return Response.json({ ok: true, scheduled_messages: staleScheduled });
      }
      return undefined;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** A Google wire event at `startUtc` (ISO, UTC), for the end-to-end smoke test. */
function evt(id: string, startUtc: string, location?: string): GoogleCalendarEvent {
  const hostCode = location && parseZoomMeetingId(location) ? HOST_CODE : null;
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: `${startUtc}Z` },
    end: { dateTime: `${startUtc}Z` },
    location,
    ...(hostCode === null ? {} : { extendedProperties: { private: { hostCode } } }),
  };
}

/** A `ReminderEvent` at `startUtc` (ISO, UTC); `reminderEvent`'s Zoom join unless `join` is given. */
function at(id: string, startUtc: string, join?: JoinInfo): ReminderEvent {
  return reminderEvent({
    id,
    title: `Event ${id}`,
    startsAt: `${startUtc}.000Z`,
    description: null,
    ...(join ? { join } : {}),
  });
}

function forms(fragment: string): URLSearchParams[] {
  return rec.callsTo(fragment).map((c) => rec.form(c));
}

describe("sendReminder — daily, end to end on Google wire events", () => {
  it("schedules a public + admin pair per event and posts the summary", async () => {
    googleEvents = [
      evt("1", "2026-05-28T18:00:00"), // +6h
      evt("2", "2026-05-28T20:00:00", ZOOM_LOCATION), // +8h
    ];
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: true, count: 2, scheduled: 2 });

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
    // The key comes from the calendar's private hostCode, never from Zoom.
    expect(scheduled[2]?.get("blocks")).not.toContain("*Host Code:*");
    expect(scheduled[3]?.get("blocks")).toContain(`*Host Code:* ${HOST_CODE}`);
    expect(rec.callsTo("zoom.us")).toHaveLength(0);

    const posts = forms("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get("channel")).toBe(env.SLACK_ANNOUNCEMENTS_CHANNEL_ID);
    expect(posts[0]?.get("text")).toContain("Today's events are:");
  });
});

describe("syncStartingSoon", () => {
  it.each(["daily-run", "calendar-change"] as const)(
    "%s: schedules a public + admin pair at start − 10 min and returns the window's events",
    async (trigger) => {
      const events = [at("1", "2026-05-28T18:00:00"), at("2", "2026-05-28T20:00:00")];
      const result = await syncStartingSoon(createCalendarFake(events), env, NOW, trigger);
      expect(result).toEqual({ events, scheduled: 2 });

      const scheduled = forms("/api/chat.scheduleMessage");
      expect(scheduled.map((f) => f.get("channel"))).toEqual([
        env.SLACK_EVENTS_CHANNEL_ID,
        env.SLACK_EVENTADMIN_CHANNEL_ID,
        env.SLACK_EVENTS_CHANNEL_ID,
        env.SLACK_EVENTADMIN_CHANNEL_ID,
      ]);
      expect(scheduled[0]?.get("post_at")).toBe(
        String(Date.parse("2026-05-28T18:00:00Z") / 1000 - 600),
      );
      expect(scheduled[0]?.get("unfurl_links")).toBe("false");
      expect(forms("/api/chat.postMessage")).toHaveLength(0);
    },
  );

  it.each(["daily-run", "calendar-change"] as const)(
    "%s: posts immediately when the slot is too near for Slack to schedule",
    async (trigger) => {
      // +10.5 min: postAt is 30 s ahead of now, inside Slack's 60 s scheduling margin.
      const calendar = createCalendarFake([at("1", "2026-05-28T12:10:30")]);
      const result = await syncStartingSoon(calendar, env, NOW, trigger);
      expect(result.scheduled).toBe(1);

      expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
      const posts = forms("/api/chat.postMessage");
      expect(posts).toHaveLength(2); // public + admin
      expect(posts[0]?.get("text")).toContain("Starting soon:");
    },
  );

  it("a fired slot (start − 10 min past) posts the pair now on the daily run", async () => {
    const calendar = createCalendarFake([at("1", "2026-05-28T12:08:00")]); // postAt = now − 2 min
    const result = await syncStartingSoon(calendar, env, NOW, "daily-run");
    expect(result.scheduled).toBe(1);
    expect(forms("/api/chat.postMessage")).toHaveLength(2);
  });

  it("a fired slot is skipped on a calendar change: re-posting would duplicate", async () => {
    const calendar = createCalendarFake([at("1", "2026-05-28T12:08:00")]);
    const result = await syncStartingSoon(calendar, env, NOW, "calendar-change");
    expect(result.scheduled).toBe(0);
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
  });

  it.each(["daily-run", "calendar-change"] as const)(
    "%s: skips an event that has already started",
    async (trigger) => {
      const started = [at("1", "2026-05-28T11:00:00")];
      // The fake drops events before the window; a real list can still return one in progress.
      const calendar = { ...createCalendarFake(), listEvents: async () => started };
      const result = await syncStartingSoon(calendar, env, NOW, trigger);
      expect(result.scheduled).toBe(0);
      expect(result.events).toHaveLength(1);
      expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
      expect(forms("/api/chat.postMessage")).toHaveLength(0);
    },
  );

  it("lists the daily window through the calendar port", async () => {
    const calendar = createCalendarFake([at("1", "2026-05-28T18:00:00")]);
    await syncStartingSoon(calendar, env, NOW, "daily-run");
    expect(calendar.callsTo("listEvents").map((c) => c.args)).toEqual([
      [reminderRange("daily", NOW)],
    ]);
  });

  it("deletes previously scheduled messages in the window before re-scheduling", async () => {
    staleScheduled = [{ id: "QSTALE", channel_id: "COLD", post_at: NOW / 1000 + 3600 }];
    const calendar = createCalendarFake([at("1", "2026-05-28T18:00:00")]);
    await syncStartingSoon(calendar, env, NOW, "daily-run");

    const deletes = forms("/api/chat.deleteScheduledMessage");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.get("channel")).toBe("COLD");
    expect(deletes[0]?.get("scheduled_message_id")).toBe("QSTALE");

    const order = rec.calls.map((c) => c.url);
    // `findLastIndex` is ES2023; the tsconfig lib is ES2022.
    const lastDelete = Math.max(
      ...order.flatMap((u, i) => (u.includes("deleteScheduledMessage") ? [i] : [])),
    );
    const firstSchedule = order.findIndex((u) => u.includes("chat.scheduleMessage"));
    expect(lastDelete).toBeLessThan(firstSchedule);
  });

  it("sweeps every page of pending messages before deleting", async () => {
    scheduledPages = [
      [{ id: "Q1", channel_id: "C1", post_at: NOW / 1000 + 3600 }],
      [{ id: "Q2", channel_id: "C2", post_at: NOW / 1000 + 7200 }],
    ];
    await syncStartingSoon(createCalendarFake(), env, NOW, "calendar-change");

    expect(forms("/api/chat.scheduledMessages.list")).toHaveLength(2);
    expect(
      forms("/api/chat.deleteScheduledMessage").map((f) => f.get("scheduled_message_id")),
    ).toEqual(["Q1", "Q2"]);
  });

  it("shows the host key only in the event-admin mirror", async () => {
    const event = at("1", "2026-05-28T18:00:00");
    await syncStartingSoon(createCalendarFake([event]), env, NOW, "daily-run");

    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    const hostKey = event.join.kind === "zoom" ? event.join.hostKey : "";
    expect(hostKey).not.toBe("");
    expect(scheduled[0]?.get("blocks")).not.toContain("*Host Code:*"); // public
    expect(scheduled[1]?.get("blocks")).toContain(`*Host Code:* ${hostKey}`); // admin
  });

  it("omits the host code line for a non-Zoom Join Link", async () => {
    const calendar = createCalendarFake([
      at("1", "2026-05-28T18:00:00", { kind: "url", url: "https://meet.google.com/abc-defg-hij" }),
    ]);
    const result = await syncStartingSoon(calendar, env, NOW, "daily-run");
    expect(result.scheduled).toBe(1);

    const scheduled = forms("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.get("blocks")).not.toContain("*Host Code:*");
  });
});

// Scheduled "Starting Soon" messages already carry this id, so a rename orphans their buttons.
it("JOIN_EVENT_ACTION_ID stays button-join-event", () => {
  expect(JOIN_EVENT_ACTION_ID).toBe("button-join-event");
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
