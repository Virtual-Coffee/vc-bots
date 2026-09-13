import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { resetGoogleTokenCacheForTests } from "../src/google/auth";
import { setLogLevel } from "../src/log";
import { route } from "../src/router";

/**
 * POST /google/notify — Google Calendar push (`watch`) notifications. The body is empty; all
 * signal is in X-Goog-* headers. There's no body signature; authenticity is the per-channel
 * token. The route ACKs fast (200) and kicks the CALENDAR_SYNC DO in the background; even dropped
 * notifications return 200 so Google doesn't retry-storm.
 *
 * We observe whether the DO was kicked through the global `fetch` spy: when kicked,
 * `processNotification` mints a Google token + lists events, so the spy sees calls to
 * `oauth2.googleapis.com` / `www.googleapis.com`. When dropped, no Google fetch happens.
 */

// ---------------------------------------------------------------------------
// Throwaway RSA service-account key (mirrors test/google-auth.test.ts)
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
  serviceAccountKey = JSON.stringify({
    client_email: "sa@test.iam.gserviceaccount.com",
    private_key: toPem(pkcs8),
  });
});

// ---------------------------------------------------------------------------
// Fetch spy — branches on hostname so we can assert whether Google was hit.
// ---------------------------------------------------------------------------

function hostnameOf(input: unknown): string {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
  return new URL(url).hostname;
}

let fetchSpy: ReturnType<typeof vi.fn>;
/** Did the spy see any Google API call (token exchange or calendar list)? */
function googleHit(): boolean {
  return fetchSpy.mock.calls.some((c) => {
    const host = hostnameOf(c[0]);
    return host === "oauth2.googleapis.com" || host === "www.googleapis.com";
  });
}

beforeEach(() => {
  resetGoogleTokenCacheForTests();
  fetchSpy = vi.fn(async (input: unknown) => {
    const host = hostnameOf(input);
    if (host === "oauth2.googleapis.com") {
      return Response.json({ access_token: "g-tok", expires_in: 3600 });
    }
    if (host === "www.googleapis.com") {
      return Response.json({ items: [] }); // empty events page → diff is a no-op
    }
    if (host === "slack.com") {
      return Response.json({ ok: true, scheduled_messages: [] });
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CHANNEL_ID = "4ba78bf0-6a47-11e2-bcfd-0800200c9a66";

/**
 * Make the singleton CalendarSync DO recognise `CHANNEL_ID` as its live channel — the DO drops
 * pushes from any other id, so the "kicks the DO" path needs a stored row to match.
 */
async function seedChannelRow(): Promise<void> {
  const stub = env.CALENDAR_SYNC.getByName("default");
  await runInDurableObject(stub, (_instance, state) => {
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
    GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey,
  }) as Env;

describe("POST /google/notify", () => {
  it("200s the initial sync notification without touching Google", async () => {
    const res = await send(gcalRequest("sync"), googleEnv());
    expect(res.status).toBe(200);
    expect(googleHit()).toBe(false);
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

  it("drops a change with a wrong channel token (200, no Google fetch) and warns", async () => {
    setLogLevel("info");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await send(
      gcalRequest("exists", { "X-Goog-Channel-Token": "wrong" }),
      googleEnv(),
    );

    expect(res.status).toBe(200);
    expect(googleHit()).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("google.notify.bad_token");
  });

  it("ignores a change when EVENT_SOURCE is not google (200, no Google fetch)", async () => {
    const res = await send(gcalRequest("exists"), {
      ...googleEnv(),
      EVENT_SOURCE: "cms",
    } as Env);

    expect(res.status).toBe(200);
    expect(googleHit()).toBe(false);
  });

  it("kicks the DO on a valid change with EVENT_SOURCE=google (200, Google fetched)", async () => {
    await seedChannelRow();
    const res = await send(gcalRequest("exists"), googleEnv());

    expect(res.status).toBe(200);
    // After draining ctx.waitUntil, processNotification has minted a token + listed events.
    expect(googleHit()).toBe(true);
  });

  it("drops a change whose channel id isn't the DO's stored channel (200, no Google fetch)", async () => {
    await seedChannelRow();
    const res = await send(
      gcalRequest("exists", { "X-Goog-Channel-ID": "00000000-0000-0000-0000-000000000000" }),
      googleEnv(),
    );

    expect(res.status).toBe(200);
    expect(googleHit()).toBe(false);
  });
});
