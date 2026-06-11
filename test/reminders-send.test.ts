import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReminder } from "../src/bots/reminders";

// Thursday 2026-05-28, 12:00 UTC (8:00 EDT). Monday variant for the daily summary skip.
const NOW = Date.parse("2026-05-28T12:00:00Z");
const MONDAY_NOW = Date.parse("2026-05-25T12:00:00Z");

interface RecordedCall {
  url: string;
  body: string;
}
let recorded: RecordedCall[];
let cmsEvents: Array<Record<string, unknown>>;
let staleScheduled: Array<{ id: string; channel_id: string; post_at: number }>;

beforeEach(() => {
  recorded = [];
  cmsEvents = [];
  staleScheduled = [];
  const spy = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    let url: string;
    let body = "";
    if (input instanceof Request) {
      url = input.url;
      body = new TextDecoder().decode(await input.clone().arrayBuffer());
    } else {
      url = String(input);
      body = typeof init?.body === "string" ? init.body : "";
    }
    recorded.push({ url, body });

    if (url === env.CMS_GRAPHQL_URL) {
      if (body.includes("getCalendars")) {
        return Response.json({
          data: { solspace_calendar: { calendars: [{ handle: "vcEvents" }] } },
        });
      }
      return Response.json({ data: { solspace_calendar: { events: cmsEvents } } });
    }
    if (url.includes("/api/chat.scheduledMessages.list")) {
      return Response.json({ ok: true, scheduled_messages: staleScheduled });
    }
    return Response.json({ ok: true, ts: "1.1", channel: "C", scheduled_message_id: "Q1" });
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

function evt(id: string, startUtc: string, channel?: string): Record<string, unknown> {
  return {
    id,
    title: `Event ${id}`,
    startDateLocalized: startUtc,
    endDateLocalized: startUtc,
    eventSlackAnnouncementsChannelId: channel ?? null,
  };
}

function forms(fragment: string): URLSearchParams[] {
  return recorded.filter((r) => r.url.includes(fragment)).map((r) => new URLSearchParams(r.body));
}

describe("sendReminder — daily", () => {
  it("schedules a public + admin pair per event and posts the summary", async () => {
    cmsEvents = [
      evt("1", "2026-05-28T18:00:00", "CX"), // +6h — the CMS per-event channel is ignored
      evt("2", "2026-05-28T20:00:00"), // +8h
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

    const posts = forms("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get("channel")).toBe(env.SLACK_ANNOUNCEMENTS_CHANNEL_ID);
    expect(posts[0]?.get("text")).toContain("Today's events are:");
  });

  it("reconciles: deletes previously scheduled messages in the window before re-scheduling", async () => {
    staleScheduled = [{ id: "QSTALE", channel_id: "COLD", post_at: NOW / 1000 + 3600 }];
    cmsEvents = [evt("1", "2026-05-28T18:00:00")];
    await sendReminder("daily", env, NOW);

    const deletes = forms("/api/chat.deleteScheduledMessage");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.get("channel")).toBe("COLD");
    expect(deletes[0]?.get("scheduled_message_id")).toBe("QSTALE");
  });

  it("posts immediately when the event starts in under 10 minutes", async () => {
    cmsEvents = [evt("1", "2026-05-28T12:05:00")]; // +5 min — the −10min slot already passed
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: true, count: 1, scheduled: 1 });

    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
    const posts = forms("/api/chat.postMessage");
    // starting-soon pair (public + admin) + the daily summary
    expect(posts).toHaveLength(3);
    expect(posts[0]?.get("text")).toContain("Starting soon:");
  });

  it("skips already-started events but still posts the summary", async () => {
    cmsEvents = [evt("1", "2026-05-28T11:00:00")]; // started 1h ago
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: true, count: 1, scheduled: 0 });

    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
    expect(forms("/api/chat.postMessage")).toHaveLength(1); // summary only
  });

  it("skips the summary on Mondays (weekly covers it) but still schedules", async () => {
    cmsEvents = [evt("1", "2026-05-25T18:00:00")];
    const result = await sendReminder("daily", env, MONDAY_NOW);
    expect(result).toEqual({ posted: false, count: 1, scheduled: 1, reason: "monday" });

    expect(forms("/api/chat.scheduleMessage")).toHaveLength(2);
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });

  it("posts nothing when there are no events", async () => {
    const result = await sendReminder("daily", env, NOW);
    expect(result).toEqual({ posted: false, count: 0, scheduled: 0, reason: "no-events" });
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });
});

describe("sendReminder — weekly", () => {
  it("posts one summary to the announcements channel and schedules nothing", async () => {
    cmsEvents = [evt("1", "2026-05-28T18:00:00"), evt("2", "2026-05-30T15:00:00", "CX")];
    const result = await sendReminder("weekly", env, NOW);
    expect(result).toEqual({ posted: true, count: 2 });

    const posts = forms("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get("channel")).toBe(env.SLACK_ANNOUNCEMENTS_CHANNEL_ID);
    expect(posts[0]?.get("text")).toContain("This weeks events are:");
    expect(forms("/api/chat.scheduleMessage")).toHaveLength(0);
    expect(forms("/api/chat.scheduledMessages.list")).toHaveLength(0);
  });

  it("posts nothing when the week is empty", async () => {
    const result = await sendReminder("weekly", env, NOW);
    expect(result).toEqual({ posted: false, count: 0, reason: "no-events" });
    expect(forms("/api/chat.postMessage")).toHaveLength(0);
  });
});
