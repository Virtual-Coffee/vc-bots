import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { JoinInfo } from "../src/events";
import {
  type CalendarPort,
  createGoogleCalendarPort,
  type GoogleCalendarEvent,
} from "../src/google/calendar";
import { type FetchRecorder, installFetchRecorder } from "./helpers/fetch-recorder";
import { generateServiceAccountKey } from "./helpers/google-key";

/**
 * The Google Calendar adapter (`createGoogleCalendarPort`) against the fetch recorder: request
 * shapes, wire → `ReminderEvent` mapping, the `getEvent` / `watch` / `stopChannel` result
 * semantics, and the per-instance token cache.
 */

const CALENDAR_ID = "vc-events@group.calendar.google.com";
const CALENDAR_PATH = `/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const WATCH_ADDRESS = "https://virtualcoffee.io/bots/google/notify";

const RANGE = {
  rangeStart: "2026-06-12T08:00:00.000-04:00",
  rangeEnd: "2026-06-13T08:00:00.000-04:00",
};

const timed = {
  start: { dateTime: "2026-06-12T19:00:00-04:00" },
  end: { dateTime: "2026-06-12T20:00:00-04:00" },
};

let serviceAccountKey: string;
beforeAll(async () => {
  ({ json: serviceAccountKey } = await generateServiceAccountKey());
});

let testEnv: Env;
let rec: FetchRecorder;
let googleEvents: GoogleCalendarEvent[];
let googlePages: object[];
/** Single-event GET answers by id; unset ids fall back to `googleEvents` then 404. */
let singleEvents: Map<string, object | Response>;

beforeEach(() => {
  googleEvents = [];
  googlePages = [];
  singleEvents = new Map();
  rec = installFetchRecorder({
    googleEvents: () => googleEvents,
    googlePages,
    googleEvent: (id) => singleEvents.get(id),
  });
  testEnv = {
    ...env,
    GOOGLE_CALENDAR_ID: CALENDAR_ID,
    GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey,
    GOOGLE_WATCH_TOKEN: "watch-tok",
  } as Env;
});
afterEach(() => vi.unstubAllGlobals());

function port(): CalendarPort {
  return createGoogleCalendarPort(testEnv);
}

/** Request headers of the `index`-th recorded fetch (the recorder keeps only url/method/body). */
function headersOf(index: number): Headers {
  const call = vi.mocked(globalThis.fetch).mock.calls[index]!;
  const [input, init] = call as [unknown, RequestInit | undefined];
  return input instanceof Request ? input.headers : new Headers(init?.headers);
}

function listCalls() {
  return rec.calls.filter((c) => new URL(c.url).pathname === `${CALENDAR_PATH}/events`);
}

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe("listEvents — request shape", () => {
  it("sends the query params, URL-encoded calendar id, and Bearer token", async () => {
    await port().listEvents(RANGE);

    const calls = listCalls();
    expect(calls).toHaveLength(1);
    const parsed = new URL(calls[0]!.url);
    expect(parsed.searchParams.get("timeMin")).toBe(RANGE.rangeStart);
    expect(parsed.searchParams.get("timeMax")).toBe(RANGE.rangeEnd);
    expect(parsed.searchParams.get("singleEvents")).toBe("true");
    expect(parsed.searchParams.get("orderBy")).toBe("startTime");
    expect(parsed.searchParams.get("maxResults")).toBe("250");
    expect(parsed.searchParams.has("pageToken")).toBe(false);

    // Token exchange first, then the list.
    expect(rec.calls[0]!.url).toBe(TOKEN_URL);
    expect(headersOf(1).get("Authorization")).toBe("Bearer g-tok");
  });

  it("follows nextPageToken and returns events from all pages", async () => {
    googlePages.push(
      { items: [{ id: "ev1", summary: "Page 1", ...timed }], nextPageToken: "p2" },
      { items: [{ id: "ev2", summary: "Page 2", ...timed }] },
    );

    const events = await port().listEvents(RANGE);

    expect(events.map((e) => e.id)).toEqual(["ev1", "ev2"]);
    const calls = listCalls();
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.has("pageToken")).toBe(false);
    expect(new URL(calls[1]!.url).searchParams.get("pageToken")).toBe("p2");
  });

  it("returns an empty array when the page has no items field", async () => {
    googlePages.push({});
    expect(await port().listEvents(RANGE)).toEqual([]);
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    rec.respondWith((call) =>
      call.url.includes("/events?") ? new Response("Forbidden", { status: 403 }) : undefined,
    );
    await expect(port().listEvents(RANGE)).rejects.toThrow(
      "Google Calendar API error: 403 Forbidden",
    );
  });
});

describe("listEvents — Join Link precedence", () => {
  async function joinOf(e: object): Promise<JoinInfo> {
    googleEvents = [e as GoogleCalendarEvent];
    const events = await port().listEvents(RANGE);
    return events[0]!.join;
  }

  it("location (the Join Link) wins over conferenceData", async () => {
    expect(
      await joinOf({
        id: "ev-loc",
        ...timed,
        location: "https://meet.example/location",
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.example/conference" }],
        },
      }),
    ).toEqual({ kind: "url", url: "https://meet.example/location" });
  });

  it("falls back to the video conferenceData entry point when there is no location", async () => {
    expect(
      await joinOf({
        id: "ev-conf",
        ...timed,
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1555" },
            { entryPointType: "video", uri: "https://meet.example/conference" },
          ],
        },
      }),
    ).toEqual({ kind: "url", url: "https://meet.example/conference" });
  });

  it("treats a blank/whitespace location as absent and falls back to conferenceData", async () => {
    expect(
      await joinOf({
        id: "ev-blank",
        ...timed,
        location: "   ",
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.example/conference" }],
        },
      }),
    ).toEqual({ kind: "url", url: "https://meet.example/conference" });
  });

  it("trims surrounding whitespace off the location", async () => {
    expect(
      await joinOf({
        id: "ev-trim",
        ...timed,
        location: "  https://zoom.us/j/81323022832 ",
        extendedProperties: { private: { hostCode: "111222" } },
      }),
    ).toEqual({
      kind: "zoom",
      url: "https://zoom.us/j/81323022832",
      meetingId: "81323022832",
      hostKey: "111222",
    });
  });

  it("is none when neither location nor video conferenceData is present", async () => {
    expect(await joinOf({ id: "ev-none", ...timed })).toEqual({ kind: "none" });
  });

  it("ignores a private joinLink property: location still wins (docs/adr/0001)", async () => {
    googleEvents = [
      {
        id: "ev-ext",
        summary: "Legacy properties",
        ...timed,
        location: "https://meet.example/location",
        extendedProperties: {
          private: { joinLink: "https://zoom.us/j/PRIVATE", hostCode: "111222" },
          shared: { joinLink: "https://zoom.us/j/SHARED", zoomHostCode: "999000" },
        },
      } as GoogleCalendarEvent,
    ];
    const events = await port().listEvents(RANGE);
    expect(events[0]!.join).toEqual({ kind: "url", url: "https://meet.example/location" });
    expect(JSON.stringify(events[0])).not.toMatch(/999000|PRIVATE|SHARED/);
  });
});

describe("listEvents — JoinInfo kinds (docs/adr/0002)", () => {
  const ZOOM = "https://us02web.zoom.us/j/81323022832?pwd=abc";

  async function joinOf(e: object): Promise<JoinInfo> {
    googleEvents = [e as GoogleCalendarEvent];
    const events = await port().listEvents(RANGE);
    return events[0]!.join;
  }

  it("zoom: a Zoom url with the private hostCode (trimmed) carries the meeting id + host key", async () => {
    expect(
      await joinOf({
        id: "ev-zoom",
        ...timed,
        location: ZOOM,
        extendedProperties: { private: { hostCode: " 111222 " } },
      }),
    ).toEqual({ kind: "zoom", url: ZOOM, meetingId: "81323022832", hostKey: "111222" });
  });

  it("url: any other http(s) link, dropping a stray hostCode", async () => {
    googleEvents = [
      {
        id: "ev-url",
        ...timed,
        location: "https://meet.google.com/abc-defg-hij",
        extendedProperties: { private: { hostCode: "111222" } },
      },
    ];
    const events = await port().listEvents(RANGE);
    expect(events[0]!.join).toEqual({ kind: "url", url: "https://meet.google.com/abc-defg-hij" });
    expect(JSON.stringify(events[0])).not.toContain("111222");
  });

  it("place: free-text location", async () => {
    expect(await joinOf({ id: "ev-place", ...timed, location: "The VC Lounge" })).toEqual({
      kind: "place",
      text: "The VC Lounge",
    });
  });

  it("place: a scheme-less location isn't classified as a url", async () => {
    expect(await joinOf({ id: "ev-http-room", ...timed, location: "http-room" })).toEqual({
      kind: "place",
      text: "http-room",
    });
  });

  it("url: an uppercase http(s) scheme still counts, and the raw string is preserved", async () => {
    expect(
      await joinOf({ id: "ev-https-upper", ...timed, location: "HTTPS://example.com/x" }),
    ).toEqual({ kind: "url", url: "HTTPS://example.com/x" });
  });

  it("place: a non-http(s) scheme Zoom-lookalike link is neither zoom nor url, and needs no hostCode", async () => {
    expect(
      await joinOf({ id: "ev-ftp-zoom", ...timed, location: "ftp://zoom.us/j/123456789" }),
    ).toEqual({ kind: "place", text: "ftp://zoom.us/j/123456789" });
  });

  it("none: empty location and no conferenceData", async () => {
    expect(await joinOf({ id: "ev-none", ...timed, location: "" })).toEqual({ kind: "none" });
  });

  it("a conferenceData fallback goes through the same rule (a Zoom entry needs the hostCode)", async () => {
    expect(
      await joinOf({
        id: "ev-conf-zoom",
        ...timed,
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: ZOOM }] },
        extendedProperties: { private: { hostCode: "111222" } },
      }),
    ).toEqual({ kind: "zoom", url: ZOOM, meetingId: "81323022832", hostKey: "111222" });
  });

  it.each([
    ["missing", {}],
    ["blank", { extendedProperties: { private: { hostCode: "   " } } }],
  ])(
    "a Zoom event with a %s hostCode is dropped and alerted to #bot-log; siblings still list",
    async (_label, props) => {
      googleEvents = [
        { id: "ev-before", ...timed, location: "https://meet.example/x" },
        { id: "ev-bad", summary: "Broken Zoom", ...timed, location: ZOOM, ...props },
        { id: "ev-after", ...timed, location: "Somewhere" },
      ];
      const events = await port().listEvents(RANGE);
      expect(events.map((e) => e.id)).toEqual(["ev-before", "ev-after"]);

      const alerts = rec.callsTo("/api/chat.postMessage");
      expect(alerts).toHaveLength(1);
      const form = rec.form(alerts[0]!);
      expect(form.get("channel")).toBe(env.SLACK_BOTLOG_CHANNEL_ID);
      expect(form.get("text")).toContain("calendar.event_rejected");
      expect(form.get("text")).toContain("Broken Zoom");
      expect(form.get("text")).toContain("ev-bad");
      expect(form.get("text")).toContain("hostCode");
      expect(form.get("text")).not.toContain("81323022832"); // no join url in the alert
    },
  );

  it("getEvent reports a Zoom event without a hostCode as invalid", async () => {
    singleEvents.set("ev-bad", { id: "ev-bad", status: "confirmed", ...timed, location: ZOOM });
    expect(await port().getEvent("ev-bad")).toEqual({
      kind: "invalid",
      reason: "zoom-no-host-key",
    });
  });
});

describe("listEvents — mapping", () => {
  it("converts an offset-bearing dateTime to UTC, maps the rest, and nulls a missing end", async () => {
    googleEvents = [
      {
        id: "ev-utc",
        summary: "UTC test",
        description: "**bold**",
        start: { dateTime: "2026-06-12T19:00:00-04:00" },
      },
    ];
    const [event] = await port().listEvents(RANGE);
    expect(event).toEqual({
      id: "ev-utc",
      title: "UTC test",
      startsAt: "2026-06-12T23:00:00.000Z",
      endsAt: null,
      description: "**bold**",
      join: { kind: "none" },
    });
  });

  it("titles an untitled event and converts the end time too", async () => {
    googleEvents = [{ id: "ev-end", ...timed }];
    const [event] = await port().listEvents(RANGE);
    expect(event!.title).toBe("(untitled event)");
    expect(event!.endsAt).toBe("2026-06-13T00:00:00.000Z");
  });

  it("drops cancelled, all-day (start.date only), and garbage-start events", async () => {
    googleEvents = [
      { id: "ev-cancelled", status: "cancelled", ...timed },
      { id: "ev-allday", start: { date: "2026-06-12" } },
      { id: "ev-garbage", start: { dateTime: "not-a-date" } },
      { id: "ev-ok", ...timed },
    ];
    const events = await port().listEvents(RANGE);
    expect(events.map((e) => e.id)).toEqual(["ev-ok"]);
  });
});

// ---------------------------------------------------------------------------
// getEvent
// ---------------------------------------------------------------------------

describe("getEvent", () => {
  it("GETs the URL-encoded event id with the Bearer token", async () => {
    singleEvents.set("ev/1", { id: "ev/1", ...timed });
    await port().getEvent("ev/1");

    const call = rec.calls[1]!;
    expect(call.method).toBe("GET");
    expect(new URL(call.url).pathname).toBe(`${CALENDAR_PATH}/events/ev%2F1`);
    expect(headersOf(1).get("Authorization")).toBe("Bearer g-tok");
  });

  it("returns a live event mapped like the list does (UTC startsAt)", async () => {
    singleEvents.set("ev-1", { id: "ev-1", summary: "Moved", status: "confirmed", ...timed });
    const lookup = await port().getEvent("ev-1");
    expect(lookup).toEqual({
      kind: "live",
      event: expect.objectContaining({
        id: "ev-1",
        title: "Moved",
        startsAt: "2026-06-12T23:00:00.000Z",
      }),
    });
  });

  it("reports a cancelled event as cancelled", async () => {
    singleEvents.set("ev-1", { id: "ev-1", status: "cancelled", ...timed });
    expect(await port().getEvent("ev-1")).toEqual({ kind: "cancelled" });
  });

  it.each([404, 410])("reports a %i (gone) as cancelled", async (status) => {
    singleEvents.set("ev-1", new Response("gone", { status }));
    expect(await port().getEvent("ev-1")).toEqual({ kind: "cancelled" });
  });

  it("reports a live all-day event (start.date only) as all-day", async () => {
    singleEvents.set("ev-1", { id: "ev-1", status: "confirmed", start: { date: "2026-06-12" } });
    expect(await port().getEvent("ev-1")).toEqual({ kind: "all-day" });
  });

  it("keeps an unparseable start.dateTime as a live event with the raw string", async () => {
    singleEvents.set("ev-1", { id: "ev-1", status: "confirmed", start: { dateTime: "not-a-date" } });
    expect(await port().getEvent("ev-1")).toEqual({
      kind: "live",
      event: expect.objectContaining({ id: "ev-1", startsAt: "not-a-date" }),
    });
  });

  it("throws on any other non-OK response (a transient failure isn't a deletion)", async () => {
    singleEvents.set("ev-1", new Response("nope", { status: 500 }));
    await expect(port().getEvent("ev-1")).rejects.toThrow(
      "Google Calendar get event failed: 500 nope",
    );
  });
});

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

describe("watch", () => {
  it("POSTs a web_hook channel with a fresh uuid, the watch token, and the 7-day ttl", async () => {
    const watch = await port().watch(WATCH_ADDRESS);

    const call = rec.calls[1]!;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe(`${CALENDAR_PATH}/events/watch`);
    expect(headersOf(1).get("Authorization")).toBe("Bearer g-tok");
    expect(headersOf(1).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual({
      id: watch.channelId,
      type: "web_hook",
      address: WATCH_ADDRESS,
      token: "watch-tok",
      params: { ttl: "604800" },
    });
    expect(watch.channelId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the resourceId and the expiration as a number", async () => {
    rec.respondWith((call) =>
      call.url.endsWith("/events/watch")
        ? Response.json({ kind: "api#channel", resourceId: "res-9", expiration: "1750000000000" })
        : undefined,
    );
    const watch = await port().watch(WATCH_ADDRESS);
    expect(watch.resourceId).toBe("res-9");
    expect(watch.expirationMs).toBe(1_750_000_000_000);
  });

  it("throws on a non-OK response", async () => {
    rec.respondWith((call) =>
      call.url.endsWith("/events/watch") ? new Response("bad address", { status: 400 }) : undefined,
    );
    await expect(port().watch(WATCH_ADDRESS)).rejects.toThrow(
      "Google Calendar watch failed: 400 bad address",
    );
  });

  it("throws on a 200 without resourceId/expiration strings", async () => {
    rec.respondWith((call) =>
      call.url.endsWith("/events/watch") ? Response.json({ resourceId: "res-1" }) : undefined,
    );
    await expect(port().watch(WATCH_ADDRESS)).rejects.toThrow(
      "Google Calendar watch returned an unexpected body shape",
    );
  });
});

// ---------------------------------------------------------------------------
// stopChannel
// ---------------------------------------------------------------------------

describe("stopChannel", () => {
  function stopResponds(status: number) {
    rec.respondWith((call) =>
      call.url.endsWith("/channels/stop") ? new Response("", { status }) : undefined,
    );
  }

  it("POSTs the id + resourceId and reports stopped on OK", async () => {
    expect(await port().stopChannel("chan-1", "res-1")).toBe("stopped");

    const call = rec.calls[1]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://www.googleapis.com/calendar/v3/channels/stop");
    expect(headersOf(1).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual({ id: "chan-1", resourceId: "res-1" });
  });

  it.each([404, 410])("reports gone on %i", async (status) => {
    stopResponds(status);
    expect(await port().stopChannel("chan-1", "res-1")).toBe("gone");
  });

  it("reports failed (and warns) on another non-OK status, never throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stopResponds(500);
    expect(await port().stopChannel("chan-1", "res-1")).toBe("failed");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "calendar_sync.stop_channel_failed channelId=chan-1 status=500",
    );
  });

  it("reports failed when the request itself throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    rec.respondWith((call) => {
      if (call.url.endsWith("/channels/stop")) throw new Error("network down");
      return undefined;
    });
    expect(await port().stopChannel("chan-1", "res-1")).toBe("failed");
  });

  it("reports gone for a null resourceId without calling Google", async () => {
    expect(await port().stopChannel("chan-1", null)).toBe("gone");
    expect(rec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Token cache (per adapter instance)
// ---------------------------------------------------------------------------

describe("token cache", () => {
  const tokenCalls = () => rec.callsTo(TOKEN_URL);

  it("mints one token and reuses it across calls while it is valid", async () => {
    const p = port();
    await p.listEvents(RANGE);
    await p.getEvent("ev-1");
    await p.stopChannel("chan-1", "res-1");
    expect(tokenCalls()).toHaveLength(1);
  });

  it("re-fetches once the token is within the 60s expiry skew", async () => {
    rec.respondWith((call) =>
      call.url === TOKEN_URL ? Response.json({ access_token: "short", expires_in: 30 }) : undefined,
    );
    const p = port();
    await p.listEvents(RANGE);
    await p.listEvents(RANGE);
    expect(tokenCalls()).toHaveLength(2);
  });

  it("does not cache a failed exchange", async () => {
    let first = true;
    rec.respondWith((call) => {
      if (call.url !== TOKEN_URL || !first) return undefined;
      first = false;
      return Response.json({ token_type: "Bearer" });
    });
    const p = port();
    await expect(p.listEvents(RANGE)).rejects.toThrow("unexpected body shape");
    await p.listEvents(RANGE);
    expect(tokenCalls()).toHaveLength(2);
  });

  it("is per instance: two adapters each mint their own token", async () => {
    await port().listEvents(RANGE);
    await port().listEvents(RANGE);
    expect(tokenCalls()).toHaveLength(2);
  });
});
