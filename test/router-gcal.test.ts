import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSync } from "../src/bots/calendar-sync/durable-object";
import type { Env } from "../src/env";
import { setLogLevel } from "../src/log";
import { route } from "../src/router";
import { createCalendarFake, type FakeCalendar, installCalendarFake } from "./helpers/calendar-fake";
import { type FetchRecorder, installFetchRecorder } from "./helpers/fetch-recorder";

/**
 * POST /google/notify — Google Calendar push (`watch`) notifications. The body is empty; all
 * signal is in X-Goog-* headers. There's no body signature; authenticity is the per-channel
 * token. The route ACKs fast (200) and kicks the CALENDAR_SYNC DO in the background; even dropped
 * notifications return 200 so Google doesn't retry-storm.
 *
 * We observe whether the DO was kicked through the calendar fake installed on the singleton
 * instance: when kicked, `processNotification` lists the weekly window, so the fake records a
 * `listEvents` call. When dropped, the fake sees nothing.
 */

let rec: FetchRecorder;
let fake: FakeCalendar;

beforeEach(async () => {
  fake = createCalendarFake();
  rec = installFetchRecorder({
    respond(call) {
      if (call.url.includes("/api/chat.scheduledMessages.list")) {
        return Response.json({ ok: true, scheduled_messages: [] });
      }
      return undefined;
    },
  });
  await withSingleton(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CHANNEL_ID = "4ba78bf0-6a47-11e2-bcfd-0800200c9a66";

/** Run `fn` on the live singleton CalendarSync with the calendar fake installed. */
function withSingleton(fn: (state: DurableObjectState) => void): Promise<void> {
  const stub = env.CALENDAR_SYNC.getByName("default");
  return runInDurableObject(stub, (instance, state) => {
    installCalendarFake(instance as unknown as CalendarSync, fake);
    fn(state);
  });
}

/**
 * Make the singleton CalendarSync DO recognise `CHANNEL_ID` as its live channel — the DO drops
 * pushes from any other id, so the "kicks the DO" path needs a stored row to match.
 */
function seedChannelRow(): Promise<void> {
  return withSingleton((state) => {
    state.storage.sql.exec("DELETE FROM channel");
    state.storage.sql.exec(
      "INSERT INTO channel (id, resource_id, expiration_ms, token) VALUES (?, ?, ?, ?)",
      CHANNEL_ID,
      "res-1",
      Date.now() + 86_400_000,
      "tok",
    );
  });
}

/** Did the sync run? (It lists the calendar first thing.) */
function synced(): boolean {
  return fake.callsTo("listEvents").length > 0;
}
/** Neither the fake nor a real Google endpoint was touched. */
function untouched(): boolean {
  return fake.calls.length === 0 && rec.callsTo("googleapis.com").length === 0;
}

// Mirrors the X-Goog-* headers Google sends on a watch notification. The channel token defaults
// to "tok"; pass an override via `extra` to simulate a spoofed/stale notification.
function gcalRequest(state: string, extra: Record<string, string> = {}): Request {
  return new Request("https://bots.example/google/notify", {
    method: "POST",
    body: "",
    headers: {
      "X-Goog-Channel-ID": CHANNEL_ID,
      "X-Goog-Channel-Token": "tok",
      "X-Goog-Resource-ID": "ret08u3rv24htgh289g",
      "X-Goog-Resource-URI": "https://www.googleapis.com/calendar/v3/calendars/cal@x/events",
      "X-Goog-Resource-State": state,
      "X-Goog-Message-Number": "1",
      ...extra,
    },
  });
}

/** Run a request through the router and drain the ctx.waitUntil work. */
async function send(req: Request, overrideEnv: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await route(req, overrideEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const googleEnv = (): Env =>
  ({
    ...env,
    EVENT_SOURCE: "google",
    GOOGLE_WATCH_TOKEN: "tok",
  }) as Env;

describe("POST /google/notify", () => {
  it("200s the initial sync notification without touching the calendar", async () => {
    const res = await send(gcalRequest("sync"), googleEnv());
    expect(res.status).toBe(200);
    expect(untouched()).toBe(true);
  });

  it("404s a non-POST method (route is POST-only)", async () => {
    const ctx = createExecutionContext();
    const res = await route(
      new Request("https://bots.example/google/notify"),
      googleEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("drops a change with a wrong channel token (200, no sync) and warns", async () => {
    setLogLevel("info");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await send(
      gcalRequest("exists", { "X-Goog-Channel-Token": "wrong" }),
      googleEnv(),
    );

    expect(res.status).toBe(200);
    expect(untouched()).toBe(true);
    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("google.notify.bad_token");
  });

  it("ignores a change when EVENT_SOURCE is not google (200, no sync)", async () => {
    const res = await send(gcalRequest("exists"), {
      ...googleEnv(),
      EVENT_SOURCE: "cms",
    } as Env);

    expect(res.status).toBe(200);
    expect(untouched()).toBe(true);
  });

  it("kicks the DO on a valid change with EVENT_SOURCE=google (200, calendar listed)", async () => {
    await seedChannelRow();
    const res = await send(gcalRequest("exists"), googleEnv());

    expect(res.status).toBe(200);
    // After draining ctx.waitUntil, processNotification has listed the weekly window.
    expect(synced()).toBe(true);
  });

  it("drops a change whose channel id isn't the DO's stored channel (200, no sync)", async () => {
    await seedChannelRow();
    const res = await send(
      gcalRequest("exists", { "X-Goog-Channel-ID": "00000000-0000-0000-0000-000000000000" }),
      googleEnv(),
    );

    expect(res.status).toBe(200);
    expect(untouched()).toBe(true);
  });
});
