import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { resetGoogleTokenCacheForTests } from "../src/google/auth";
import {
  createGoogleCalendarSource,
  type GoogleCalendarEvent,
} from "../src/bots/reminders/sources/google-calendar";

const CALENDAR_ID = "vc-events@group.calendar.google.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const RANGE = {
  rangeStart: "2026-06-12T08:00:00.000-04:00",
  rangeEnd: "2026-06-13T08:00:00.000-04:00",
};

// ---------------------------------------------------------------------------
// Throwaway RSA key generation (mirrors test/google-auth.test.ts)
// ---------------------------------------------------------------------------

let serviceAccountKey: string;

function toPem(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const privateKeyPem = toPem(pkcs8);
  serviceAccountKey = JSON.stringify({
    client_email: "sa@test.iam.gserviceaccount.com",
    private_key: privateKeyPem,
  });
});

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let testEnv: Env;
/** Queue of page responses for the calendar events endpoint. Popped in order. */
let pageQueue: Array<object>;
/** All recorded fetch calls (URL + init). */
let recorded: Array<{ url: string; init: RequestInit | undefined }>;

function makeCalendarUrl(calendarId: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

beforeEach(() => {
  resetGoogleTokenCacheForTests();
  pageQueue = [];
  recorded = [];
  testEnv = { ...env, GOOGLE_CALENDAR_ID: CALENDAR_ID, GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey } as Env;

  const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    recorded.push({ url, init: input instanceof Request ? undefined : init });

    if (url === TOKEN_URL) {
      return Response.json({ access_token: "g-tok", expires_in: 3600 });
    }

    // Calendar events endpoint — pop from the queue.
    const page = pageQueue.shift();
    if (page === undefined) {
      return Response.json({ items: [] });
    }
    return Response.json(page);
  });

  vi.stubGlobal("fetch", spy);
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Helper to record calendar-events calls only
// ---------------------------------------------------------------------------

function calendarCalls(): Array<{ url: string; init: RequestInit | undefined }> {
  const base = makeCalendarUrl(CALENDAR_ID);
  return recorded.filter((r) => r.url.startsWith(base));
}

// ---------------------------------------------------------------------------
// 1. Request shape
// ---------------------------------------------------------------------------

describe("request shape", () => {
  it("sends correct query params, URL-encoded calendar id, and Bearer token", async () => {
    pageQueue.push({ items: [] });
    await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);

    const calls = calendarCalls();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;

    const parsed = new URL(call.url);
    expect(parsed.pathname).toBe(
      `/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
    );
    expect(parsed.searchParams.get("timeMin")).toBe(RANGE.rangeStart);
    expect(parsed.searchParams.get("timeMax")).toBe(RANGE.rangeEnd);
    expect(parsed.searchParams.get("singleEvents")).toBe("true");
    expect(parsed.searchParams.get("orderBy")).toBe("startTime");
    expect(parsed.searchParams.get("maxResults")).toBe("250");
    expect(parsed.searchParams.has("pageToken")).toBe(false);

    // Authorization header — may come from Request or init headers.
    const initHeaders = new Headers(call.init?.headers);
    expect(initHeaders.get("Authorization")).toBe("Bearer g-tok");
  });
});

// ---------------------------------------------------------------------------
// 2. Pagination
// ---------------------------------------------------------------------------

describe("pagination", () => {
  it("follows nextPageToken and returns events from all pages", async () => {
    const page1Event: GoogleCalendarEvent = {
      id: "ev1",
      summary: "Page 1 Event",
      start: { dateTime: "2026-06-12T14:00:00-04:00" },
      end: { dateTime: "2026-06-12T15:00:00-04:00" },
    };
    const page2Event: GoogleCalendarEvent = {
      id: "ev2",
      summary: "Page 2 Event",
      start: { dateTime: "2026-06-12T16:00:00-04:00" },
      end: { dateTime: "2026-06-12T17:00:00-04:00" },
    };

    pageQueue.push({ items: [page1Event], nextPageToken: "p2" });
    pageQueue.push({ items: [page2Event] });

    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);

    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("ev1");
    expect(events[1]!.id).toBe("ev2");

    const calls = calendarCalls();
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.has("pageToken")).toBe(false);
    expect(new URL(calls[1]!.url).searchParams.get("pageToken")).toBe("p2");
  });
});

// ---------------------------------------------------------------------------
// 3. joinLink mapping precedence
// ---------------------------------------------------------------------------

describe("joinLink precedence", () => {
  const timed = {
    start: { dateTime: "2026-06-12T19:00:00-04:00" },
    end: { dateTime: "2026-06-12T20:00:00-04:00" },
  };

  it("location (the Join Link) wins over conferenceData", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-loc",
      summary: "Location wins",
      ...timed,
      location: "https://zoom.us/j/location",
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/conference" }],
      },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.joinLink).toBe("https://zoom.us/j/location");
  });

  it("falls back to the video conferenceData entry point when there is no location", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-conf",
      summary: "Conference fallback",
      ...timed,
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+1555" },
          { entryPointType: "video", uri: "https://zoom.us/j/conference" },
        ],
      },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.joinLink).toBe("https://zoom.us/j/conference");
  });

  it("treats a blank/whitespace location as absent and falls back to conferenceData", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-blank",
      summary: "Blank location",
      ...timed,
      location: "   ",
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/conference" }],
      },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.joinLink).toBe("https://zoom.us/j/conference");
  });

  it("trims surrounding whitespace off the location", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-trim",
      summary: "Padded location",
      ...timed,
      location: "  https://zoom.us/j/81323022832 ",
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.joinLink).toBe("https://zoom.us/j/81323022832");
  });

  it("returns null when neither location nor video conferenceData is present", async () => {
    const e: GoogleCalendarEvent = { id: "ev-none", summary: "No link", ...timed };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.joinLink).toBeNull();
  });

  it("ignores a private joinLink property: location still wins (docs/adr/0001)", async () => {
    const e = {
      id: "ev-ext",
      summary: "Legacy properties",
      ...timed,
      location: "https://zoom.us/j/location",
      extendedProperties: {
        private: { joinLink: "https://zoom.us/j/PRIVATE", hostCode: "111222" },
        shared: { joinLink: "https://zoom.us/j/SHARED", zoomHostCode: "999000" },
      },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.joinLink).toBe("https://zoom.us/j/location");
    expect(JSON.stringify(events[0])).not.toMatch(/999000|PRIVATE|SHARED/);
  });
});

// ---------------------------------------------------------------------------
// 3b. hostKey mapping
// ---------------------------------------------------------------------------

describe("hostKey mapping", () => {
  const timed = {
    start: { dateTime: "2026-06-12T19:00:00-04:00" },
    end: { dateTime: "2026-06-12T20:00:00-04:00" },
  };

  it("reads extendedProperties.private.hostCode, trimmed", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-host",
      summary: "Host key",
      ...timed,
      location: "https://zoom.us/j/81323022832",
      extendedProperties: { private: { hostCode: " 111222 " } },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.hostKey).toBe("111222");
  });

  it("maps a missing or blank hostCode to null", async () => {
    const missing: GoogleCalendarEvent = { id: "ev-nohost", summary: "No host key", ...timed };
    const blank: GoogleCalendarEvent = {
      id: "ev-blank",
      summary: "Blank host key",
      ...timed,
      extendedProperties: { private: { hostCode: "   " } },
    };
    pageQueue.push({ items: [missing, blank] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events.map((ev) => ev.hostKey)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// 4. UTC conversion and missing end
// ---------------------------------------------------------------------------

describe("startsAt UTC conversion and endsAt", () => {
  it("converts offset-bearing dateTime to UTC and returns null endsAt when missing", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-utc",
      summary: "UTC test",
      start: { dateTime: "2026-06-12T19:00:00-04:00" },
      // no end
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events[0]!.startsAt).toBe("2026-06-12T23:00:00.000Z");
    expect(events[0]!.endsAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Dropped events
// ---------------------------------------------------------------------------

describe("dropped events", () => {
  it("drops cancelled events", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-cancelled",
      status: "cancelled",
      summary: "Cancelled",
      start: { dateTime: "2026-06-12T19:00:00-04:00" },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events).toHaveLength(0);
  });

  it("drops all-day events (no start.dateTime)", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-allday",
      summary: "All Day",
      start: { date: "2026-06-12" },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events).toHaveLength(0);
  });

  it("drops events with garbage start.dateTime", async () => {
    const e: GoogleCalendarEvent = {
      id: "ev-garbage",
      summary: "Bad date",
      start: { dateTime: "not-a-date" },
    };
    pageQueue.push({ items: [e] });
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Non-200 response
// ---------------------------------------------------------------------------

describe("non-200 response", () => {
  it("rejects with the HTTP status in the error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === TOKEN_URL) {
          return Response.json({ access_token: "g-tok", expires_in: 3600 });
        }
        return new Response("Forbidden", { status: 403 });
      }),
    );

    await expect(createGoogleCalendarSource(testEnv).fetchEvents(RANGE)).rejects.toThrow("403");
  });
});

// ---------------------------------------------------------------------------
// 7. Empty page
// ---------------------------------------------------------------------------

describe("empty page", () => {
  it("returns an empty array when the response has no items field", async () => {
    pageQueue.push({});
    const events = await createGoogleCalendarSource(testEnv).fetchEvents(RANGE);
    expect(events).toEqual([]);
  });
});
