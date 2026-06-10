import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/router";

/**
 * GET /join/<token> — the opaque per-user redirect behind the ephemeral's ☕ Join button. The
 * token is the credential (minted by the DO on a Join click); it resolves to the personal Zoom
 * join url and 302s the browser there. Keeps the token-bearing Zoom url out of the Slack UI.
 */

beforeEach(() => {
  const spy = vi.fn(async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("zoom.us/oauth/token")) {
      return Response.json({ access_token: "zt", token_type: "bearer", expires_in: 3600 });
    }
    if (url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({ attendees: [{ name: "Ada", join_url: "https://zoom.us/w/personal-7" }] });
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", spy);
});

afterEach(() => vi.unstubAllGlobals());

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await route(new Request(`https://bots.example${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /join/<token>", () => {
  it("302s a minted token to the personal Zoom url, uncached", async () => {
    const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
    const { token } = await stub.handleJoinRequest({ slackUserId: "U777", displayName: "Ada" });

    const res = await get(`/join/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://zoom.us/w/personal-7");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s an unknown token", async () => {
    const res = await get(`/join/${"0".repeat(32)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/expired/i);
  });

  it("404s a malformed token without touching the DO", async () => {
    const res = await get("/join/not%20a%20token!");
    expect(res.status).toBe(404);
  });
});
