import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { resetGoogleTokenCacheForTests } from "../src/google/auth";
import { createGoogleCalendarSource } from "../src/bots/reminders/sources/google-calendar";

const CLIENT_EMAIL = "sa@test.iam.gserviceaccount.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_ID = "test-calendar@group.calendar.google.com";
const CALENDAR_API_BASE = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

function toPem(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

let serviceAccountKey: string;

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
  serviceAccountKey = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: privateKeyPem });
});

let testEnv: Env;

beforeEach(() => {
  resetGoogleTokenCacheForTests();
  testEnv = {
    ...env,
    GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey,
    GOOGLE_CALENDAR_ID: CALENDAR_ID,
  } as Env;
});

afterEach(() => vi.unstubAllGlobals());

/** A minimal timed Google Calendar event shape. */
function makeEvent(
  id: string,
  overrides: Partial<{
    summary: string;
    startDateTime: string;
    endDateTime: string;
    extendedProperties: { private?: Record<string, string>; shared?: Record<string, string> };
  }> = {},
) {
  return {
    id,
    status: "confirmed",
    summary: overrides.summary ?? `Event ${id}`,
    start: { dateTime: overrides.startDateTime ?? "2026-07-01T15:00:00-04:00" },
    end: { dateTime: overrides.endDateTime ?? "2026-07-01T16:00:00-04:00" },
    extendedProperties: overrides.extendedProperties,
  };
}

const RANGE = {
  rangeStart: "2026-07-01T00:00:00Z",
  rangeEnd: "2026-07-02T00:00:00Z",
};

describe("createGoogleCalendarSource – extendedProperties priority", () => {
  it("private joinLink and hostCode win over shared values", async () => {
    const eventsPage = {
      items: [
        makeEvent("evt-1", {
          extendedProperties: {
            private: { joinLink: "https://zoom.us/j/PRIVATE", hostCode: "111222" },
            shared: { joinLink: "https://zoom.us/j/SHARED", zoomHostCode: "999000" },
          },
        }),
      ],
    };

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(TOKEN_URL)) {
        return Response.json({ access_token: "g-tok", expires_in: 3600 });
      }
      if (url.startsWith(CALENDAR_API_BASE)) {
        return Response.json(eventsPage);
      }
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const source = createGoogleCalendarSource(testEnv);
    const events = await source.fetchEvents(RANGE);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.joinLink).toBe("https://zoom.us/j/PRIVATE");
    expect(event.zoomHostCode).toBe("111222");
  });

  it("falls back to shared joinLink and zoomHostCode when private is absent", async () => {
    const eventsPage = {
      items: [
        makeEvent("evt-2", {
          extendedProperties: {
            shared: { joinLink: "https://zoom.us/j/SHARED", zoomHostCode: "999000" },
          },
        }),
      ],
    };

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(TOKEN_URL)) {
        return Response.json({ access_token: "g-tok", expires_in: 3600 });
      }
      if (url.startsWith(CALENDAR_API_BASE)) {
        return Response.json(eventsPage);
      }
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const source = createGoogleCalendarSource(testEnv);
    const events = await source.fetchEvents(RANGE);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.joinLink).toBe("https://zoom.us/j/SHARED");
    expect(event.zoomHostCode).toBe("999000");
  });

  it("reads slackChannelId from private, falling back to shared", async () => {
    const eventsPage = {
      items: [
        makeEvent("evt-priv-chan", {
          extendedProperties: {
            private: { slackChannelId: "C_PRIV" },
            shared: { slackChannelId: "C_SHARED" },
          },
        }),
        makeEvent("evt-shared-chan", {
          extendedProperties: {
            shared: { slackChannelId: "C_SHARED_ONLY" },
          },
        }),
      ],
    };

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(TOKEN_URL)) {
        return Response.json({ access_token: "g-tok", expires_in: 3600 });
      }
      if (url.startsWith(CALENDAR_API_BASE)) {
        return Response.json(eventsPage);
      }
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const source = createGoogleCalendarSource(testEnv);
    const events = await source.fetchEvents(RANGE);

    expect(events).toHaveLength(2);
    expect(events[0]!.slackChannelId).toBe("C_PRIV");
    expect(events[1]!.slackChannelId).toBe("C_SHARED_ONLY");
  });
});
