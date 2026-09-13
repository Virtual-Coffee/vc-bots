import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSync } from "../src/bots/calendar-sync/durable-object";
import { resetGoogleTokenCacheForTests } from "../src/google/auth";

/**
 * Unit-tests the CalendarSync DO directly via `runInDurableObject` (no RPC): we get the live
 * instance and call its methods. A single `fetch` spy branches on hostname + pathname so we can
 * shape Google Calendar responses (watch / events list / single-event GET / channels.stop) and
 * count Slack posts.
 *
 * The DO reads its own `this.env` (the namespace binding), NOT a per-test override — so the
 * service-account key, watch token/address, and calendar id come from the pinned miniflare
 * bindings in `vitest.config.ts`. Only `fetch` is stubbed here.
 */

// A fixed "now" for the diff tests: Wednesday 2026-06-17, 12:00 EDT. Its ISO week runs Monday
// 2026-06-15 → Monday 2026-06-22, so `at(+48h)`/`at(+72h)` land on Fri/Sat (in-window, future),
// `at(-24h)` is Tuesday (in-window, past), and `at(+6d)` is next Tuesday (out of window).
const NOW = Date.parse("2026-06-17T16:00:00Z");
const NOW_DT = DateTime.fromMillis(NOW, { zone: "America/New_York" });

// ---------------------------------------------------------------------------
// Fetch spy — branches on hostname/pathname. Tests mutate `eventsList` and the
// `singleEvents` map to script the calendar responses for each phase.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  body: string;
}
let recorded: RecordedCall[];

/** What the events-list endpoint returns next (an Events: list page). */
let eventsList: object;
/** Per-id responses for the single-event GET. Missing id → 404 (event is gone). */
let singleEvents: Map<string, { body: object; status?: number }>;
/** Body returned by POST /events/watch. */
let watchResponse: object;

function normalizeUrl(input: unknown): string {
  return typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
}

function makeFetchSpy() {
  return vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const urlStr = normalizeUrl(input);
    const url = new URL(urlStr);
    const { hostname, pathname } = url;
    let body = "";
    if (input instanceof Request) {
      body = await input.clone().text();
    } else {
      body = typeof init?.body === "string" ? init.body : "";
    }
    recorded.push({ url: urlStr, body });

    if (hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "g-tok", expires_in: 3600 });
    }

    if (hostname === "www.googleapis.com") {
      // Stop a push channel.
      if (pathname === "/calendar/v3/channels/stop") {
        return Response.json({});
      }
      // Create a watch channel.
      if (pathname.endsWith("/events/watch")) {
        return Response.json(watchResponse);
      }
      // Single-event GET: /calendar/v3/calendars/{id}/events/{eventId}
      const single = pathname.match(/\/events\/([^/]+)$/);
      if (single && url.search === "") {
        const id = decodeURIComponent(single[1]!);
        const hit = singleEvents.get(id);
        if (!hit) return new Response("not found", { status: 404 });
        return Response.json(hit.body, { status: hit.status ?? 200 });
      }
      // Events list (carries query params: timeMin/timeMax/...).
      if (pathname.endsWith("/events")) {
        return Response.json(eventsList);
      }
      return Response.json({});
    }

    if (hostname === "slack.com") {
      if (pathname === "/api/chat.scheduledMessages.list") {
        return Response.json({ ok: true, scheduled_messages: [] });
      }
      return Response.json({ ok: true, ts: "1", scheduled_message_id: "x" });
    }

    return Response.json({ ok: true });
  });
}

beforeEach(() => {
  resetGoogleTokenCacheForTests();
  recorded = [];
  eventsList = { items: [] };
  singleEvents = new Map();
  watchResponse = {
    resourceId: "res-1",
    expiration: String(Date.now() + 7 * 86_400_000),
  };
  vi.stubGlobal("fetch", makeFetchSpy());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Address a fresh DO instance per test (unique name → isolated SQLite, no snapshot leakage). */
function syncStub(name = `cs-${crypto.randomUUID()}`) {
  const ns = env.CALENDAR_SYNC;
  const id = ns.idFromName(name);
  return ns.get(id);
}

/**
 * Run a callback against the live CalendarSync instance. The test-env binding type isn't narrowed
 * to `CalendarSync`, so we cast the instance for the callback — `runInDurableObject` hands back the
 * real object either way.
 */
function withSync<T>(
  stub: ReturnType<typeof syncStub>,
  fn: (instance: CalendarSync, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, (instance, state) =>
    fn(instance as unknown as CalendarSync, state),
  );
}

function slackPosts(): RecordedCall[] {
  return recorded.filter((r) => r.url.includes("/api/chat.postMessage"));
}
function watchCalls(): RecordedCall[] {
  return recorded.filter((r) => r.url.includes("/events/watch"));
}

/** A timed Google Calendar Events: list item; `location` is the Join Link. */
function timedEvent(
  id: string,
  startDateTime: string,
  summary = "Event",
  location?: string,
  hostCode?: string,
) {
  return {
    id,
    summary,
    start: { dateTime: startDateTime },
    end: { dateTime: DateTime.fromISO(startDateTime).plus({ hours: 1 }).toISO() },
    location,
    ...(hostCode === undefined ? {} : { extendedProperties: { private: { hostCode } } }),
  };
}

/** An ISO instant `hours` from the fixed `NOW` (negative = past), Eastern offset. */
function at(hours: number): string {
  return NOW_DT.plus({ hours }).set({ second: 0, millisecond: 0 }).toISO()!;
}

// ---------------------------------------------------------------------------
// Watch lifecycle
// ---------------------------------------------------------------------------

describe("CalendarSync — ensureWatch", () => {
  it("creates and stores a channel, seeds an empty snapshot, and arms the alarm", async () => {
    const stub = syncStub();

    const status = await withSync(stub, (instance) =>
      instance.ensureWatch(),
    );

    expect(status.active).toBe(true);
    expect(status.channelId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof status.expiresAt).toBe("number");

    // A watch channel was created.
    expect(watchCalls()).toHaveLength(1);

    // The channel row was stored.
    const channels = await withSync(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM channel").toArray(),
    );
    expect(channels).toHaveLength(1);
    expect(channels[0]?.resource_id).toBe("res-1");

    // watchStatus reports active.
    const live = await withSync(stub, (instance) =>
      instance.watchStatus(),
    );
    expect(live.active).toBe(true);
  });
});

describe("CalendarSync — alarm renewal", () => {
  it("runs the renewal alarm without throwing", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());

    // An alarm was armed by ensureWatch; firing it re-runs ensureWatch (healthy → re-arm).
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // The channel still exists and is active afterward.
    const live = await withSync(stub, (instance) =>
      instance.watchStatus(),
    );
    expect(live.active).toBe(true);
  });
});

describe("CalendarSync — stopWatch", () => {
  it("stops the channel and reports inactive afterward", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());

    const stopped = await withSync(stub, (instance) =>
      instance.stopWatch(),
    );
    expect(stopped).toEqual({ stopped: true });
    expect(recorded.some((r) => r.url.includes("/channels/stop"))).toBe(true);

    const live = await withSync(stub, (instance) =>
      instance.watchStatus(),
    );
    expect(live.active).toBe(false);
    expect(live.channelId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// processNotification — diff detection
// ---------------------------------------------------------------------------

describe("CalendarSync — processNotification", () => {
  it("posts a cancellation notice when an upcoming snapshot event disappears (cancelled)", async () => {
    const stub = syncStub();

    // Seed the snapshot with one upcoming timed event (Friday this week).
    eventsList = { items: [timedEvent("evt-1", at(48))] };
    await withSync(stub, (instance) => instance.seed(NOW));

    // Now the event is gone from the live window, and the single-event GET says cancelled.
    eventsList = { items: [] };
    singleEvents.set("evt-1", { body: { status: "cancelled" } });
    recorded = [];

    await withSync(stub, (instance) => instance.processNotification(NOW));

    // One cancellation → posted to all three event channels.
    const posts = slackPosts();
    expect(posts).toHaveLength(3);
    const text = posts.map((p) => new URLSearchParams(p.body).get("text") ?? "").join("\n");
    expect(text).toContain("Cancelled");
  });

  it("posts a reschedule notice when an upcoming event's start time changes in-window", async () => {
    const stub = syncStub();

    eventsList = { items: [timedEvent("evt-1", at(48))] }; // Friday
    await withSync(stub, (instance) => instance.seed(NOW));

    // Same event, different start time (Saturday — still in this week's window).
    eventsList = { items: [timedEvent("evt-1", at(72))] };
    recorded = [];

    await withSync(stub, (instance) => instance.processNotification(NOW));

    const posts = slackPosts();
    expect(posts).toHaveLength(3);
    const text = posts.map((p) => new URLSearchParams(p.body).get("text") ?? "").join("\n");
    expect(text).toContain("Rescheduled");
  });

  it("posts a reschedule notice when an upcoming event moves out of the week", async () => {
    const stub = syncStub();

    eventsList = { items: [timedEvent("evt-1", at(48))] }; // Friday, this week
    await withSync(stub, (instance) => instance.seed(NOW));

    // The event left this week's window; the single-event GET confirms it's alive at a new time
    // (next Tuesday) — an out-of-window reschedule, not a cancellation.
    eventsList = { items: [] };
    singleEvents.set("evt-1", { body: { status: "confirmed", start: { dateTime: at(24 * 6) } } });
    recorded = [];

    await withSync(stub, (instance) => instance.processNotification(NOW));

    const posts = slackPosts();
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => new URLSearchParams(p.body).get("text") ?? "").join("\n")).toContain(
      "Rescheduled",
    );
  });

  it("does NOT notify when the changed event's announced start is already in the past", async () => {
    const stub = syncStub();

    // Seed an event earlier this week (Tuesday), before `NOW` (Wednesday).
    eventsList = { items: [timedEvent("evt-1", at(-24))] };
    await withSync(stub, (instance) => instance.seed(NOW));

    // It disappears and the GET says cancelled — but its announced slot already passed.
    eventsList = { items: [] };
    singleEvents.set("evt-1", { body: { status: "cancelled" } });
    recorded = [];

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(slackPosts()).toHaveLength(0);
  });

  it("posts nothing when the live window matches the snapshot", async () => {
    const stub = syncStub();

    eventsList = { items: [timedEvent("evt-1", at(48))] };
    await withSync(stub, (instance) => instance.seed(NOW));

    recorded = [];
    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(slackPosts()).toHaveLength(0);
  });

  it("re-queues the daily starting-soon pair with the Zoom host key in the event-admin mirror", async () => {
    const stub = syncStub();

    // Later today (in the daily window), with a Zoom Join Link as the location and its host code.
    const zoom = timedEvent("evt-1", at(6), "Event", "https://us02web.zoom.us/j/81323022832?pwd=x", "123456");
    eventsList = { items: [zoom] };
    await withSync(stub, (instance) => instance.seed(NOW));

    recorded = [];
    await withSync(stub, (instance) => instance.processNotification(NOW));

    const scheduled = recorded.filter((r) => r.url.includes("/api/chat.scheduleMessage"));
    expect(scheduled).toHaveLength(2);
    expect(new URLSearchParams(scheduled[0]!.body).get("blocks")).not.toContain("*Host Code:*");
    expect(new URLSearchParams(scheduled[1]!.body).get("blocks")).toContain("*Host Code:* 123456");
  });
});
