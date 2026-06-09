import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { hmacSha256Hex } from "../src/crypto";
import { route } from "../src/router";

/**
 * /zoom/webhook routing: the webhook subscription is account-wide, so events arrive for every
 * meeting under the account — only the configured co-working meeting may reach the DO.
 */

const SECRET = "zoom_webhook_secret_token_example";

interface RecordedCall {
  url: string;
}
let recorded: RecordedCall[];

beforeEach(() => {
  recorded = [];
  const spy = vi.fn(async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    recorded.push({ url });
    return Response.json({ ok: true, ts: "1700000000.000100", channel: "C0B6C3BFEDD" });
  });
  vi.stubGlobal("fetch", spy);
});

afterEach(() => vi.unstubAllGlobals());

// --- helpers ---

function testEnv(): Env {
  return { ...env, ZOOM_WEBHOOK_SECRET_TOKEN: SECRET };
}

function startedEvent(meetingId: string) {
  return {
    event: "meeting.started",
    event_ts: Date.now(),
    payload: { object: { id: meetingId, uuid: `uuid-${meetingId}` } },
  };
}

async function signedZoomRequest(body: unknown): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex(SECRET, `v0:${timestamp}:${rawBody}`)}`;
  return new Request("https://bots.example/zoom/webhook", {
    method: "POST",
    body: rawBody,
    headers: {
      "x-zm-request-timestamp": timestamp,
      "x-zm-signature": signature,
    },
  });
}

// --- tests ---

describe("POST /zoom/webhook — meeting ID filter", () => {
  it("ignores events for other meetings under the account (200, no Slack call)", async () => {
    const ctx = createExecutionContext();
    const req = await signedZoomRequest(startedEvent("999000111"));

    const res = await route(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200); // 200, not 4xx — Zoom retries non-2xx and can drop the endpoint
    expect(recorded).toHaveLength(0);
  });

  it("dispatches events for the configured co-working meeting to the DO", async () => {
    const ctx = createExecutionContext();
    const req = await signedZoomRequest(startedEvent(env.ZOOM_MEETING_ID));

    const res = await route(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(recorded.some((r) => r.url.includes("/api/chat.postMessage"))).toBe(true);
  });
});
