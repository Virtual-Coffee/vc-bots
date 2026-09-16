import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { hmacSha256Hex } from "../src/crypto";
import { route } from "../src/router";
import { installFetchRecorder, type FetchRecorder } from "./helpers/fetch-recorder";
import { signZoom } from "./helpers/signing";

/**
 * `POST /zoom/webhook` (`src/zoom/webhook.ts`) through `route()`: real signature verification
 * against the raw body, the `endpoint.url_validation` handshake, the account-wide meeting-ID
 * filter, and dispatch into the real CoworkingRoom DO — all inside workerd with a stubbed fetch.
 */

const SECRET = "zoom_webhook_secret_token_example";
const MEETING = env.ZOOM_MEETING_ID;

let fetched: FetchRecorder;

beforeEach(() => {
  fetched = installFetchRecorder();
});
afterEach(() => vi.unstubAllGlobals());

// --- helpers ---

function testEnv(): Env {
  return { ...env, ZOOM_WEBHOOK_SECRET_TOKEN: SECRET };
}

function meetingEvent(
  event: string,
  meetingId: string,
  participant?: { user_id: string; user_name: string },
) {
  return {
    event,
    event_ts: Date.now(),
    payload: {
      object: { id: meetingId, uuid: `uuid-${meetingId}`, ...(participant ? { participant } : {}) },
    },
  };
}

function startedEvent(meetingId: string) {
  return meetingEvent("meeting.started", meetingId);
}

/** POST `rawBody` through the router, signed with `secret` (or not at all). */
async function post(rawBody: string, secret: string | null = SECRET): Promise<Response> {
  const req = new Request("https://bots.example/zoom/webhook", {
    method: "POST",
    body: rawBody,
    headers: secret === null ? {} : await signZoom(secret, rawBody),
  });
  const ctx = createExecutionContext();
  const res = await route(req, testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const postJson = (body: unknown) => post(JSON.stringify(body));

const slackPosts = () => fetched.callsTo("/api/chat.postMessage");
const botLogPosts = () =>
  slackPosts().filter((c) => fetched.form(c).get("channel") === env.SLACK_BOTLOG_CHANNEL_ID);

/** The configured meeting's DO rows (storage is isolated per test, so no cross-talk). */
async function sessions() {
  return runInDurableObject(env.COWORKING_ROOM.getByName(MEETING), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM session").toArray(),
  );
}

// --- tests ---

describe("POST /zoom/webhook — signature + handshake", () => {
  it("rejects a request signed with the wrong secret (401, nothing dispatched)", async () => {
    const res = await post(JSON.stringify(startedEvent(MEETING)), "not-the-secret");
    expect(res.status).toBe(401);
    expect(fetched.calls).toHaveLength(0);
  });

  it("rejects an unsigned request (401)", async () => {
    const res = await post(JSON.stringify(startedEvent(MEETING)), null);
    expect(res.status).toBe(401);
    expect(fetched.calls).toHaveLength(0);
  });

  it("answers 400 to a signed but malformed body", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(fetched.calls).toHaveLength(0);
  });

  it("answers the endpoint.url_validation handshake with the HMAC of plainToken", async () => {
    const plainToken = "qgg8vlvZRS6UYooatFL8Aw";
    const res = await postJson({ event: "endpoint.url_validation", payload: { plainToken } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      plainToken,
      encryptedToken: await hmacSha256Hex(SECRET, plainToken),
    });
    expect(fetched.calls).toHaveLength(0);
  });

  it("404s a GET", async () => {
    const req = new Request("https://bots.example/zoom/webhook");
    const res = await route(req, testEnv(), createExecutionContext());
    expect(res.status).toBe(404);
  });
});

describe("POST /zoom/webhook — meeting ID filter", () => {
  it("ignores a non-meeting event (200, no Slack call)", async () => {
    const res = await postJson({ event: "recording.completed", payload: {} });
    expect(res.status).toBe(200);
    expect(fetched.calls).toHaveLength(0);
  });

  it("ignores events for other meetings under the account (200, no Slack call)", async () => {
    const res = await postJson(startedEvent("999000111"));
    expect(res.status).toBe(200); // 200, not 4xx — Zoom retries non-2xx and can drop the endpoint
    expect(fetched.calls).toHaveLength(0);
  });

  it("dispatches events for the configured co-working meeting to the DO", async () => {
    const res = await postJson(startedEvent(MEETING));
    expect(res.status).toBe(200);
    expect(slackPosts()).toHaveLength(1);
  });
});

describe("POST /zoom/webhook — dispatch into the room", () => {
  it("drives the session through joined / left / ended", async () => {
    const uuid = `uuid-${MEETING}`;
    expect((await postJson(startedEvent(MEETING))).status).toBe(200);
    expect((await sessions()).find((r) => r.instance_uuid === uuid)?.status).toBe("active");

    const ada = { user_id: "p1", user_name: "Ada" };
    expect((await postJson(meetingEvent("meeting.participant_joined", MEETING, ada))).status).toBe(200);
    expect(fetched.lastBlocks("/api/chat.update")).toContain("Ada");

    expect((await postJson(meetingEvent("meeting.participant_left", MEETING, ada))).status).toBe(200);
    expect(fetched.lastBlocks("/api/chat.update")).not.toContain("Ada");

    expect((await postJson(meetingEvent("meeting.ended", MEETING))).status).toBe(200);
    expect(fetched.lastBlocks("/api/chat.update")).toContain("session has ended");
    expect((await sessions()).find((r) => r.instance_uuid === uuid)?.status).toBe("ended");
  });

  it("alerts #bot-log and still 200s when the DO throws", async () => {
    // The open-card post fails inside the DO (Slack rejects the co-working channel) — the
    // error propagates out of handleZoomEvent, and the route must swallow it into an alert.
    fetched.respondWith((call) => {
      if (
        call.url.includes("/api/chat.postMessage") &&
        new URLSearchParams(call.body).get("channel") === env.SLACK_COWORKING_CHANNEL_ID
      ) {
        return Response.json({ ok: false, error: "channel_not_found" });
      }
      return undefined;
    });

    const res = await postJson(startedEvent(MEETING));

    expect(res.status).toBe(200); // never a non-2xx: Zoom would retry-storm / drop the endpoint
    const alerts = botLogPosts();
    expect(alerts).toHaveLength(1);
    const text = fetched.form(alerts[0]!).get("text") ?? "";
    expect(text).toContain("zoom.webhook.failed");
    expect(text).toContain("channel_not_found");
  });
});
