import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "../src/crypto";
import { route } from "../src/router";

/**
 * End-to-end coverage of the SlackApp pipeline (`src/slack/app.ts`) through `route()`:
 * real signature verification against the raw body, the `url_verification` handshake, and
 * the lazy handlers' outbound calls — all inside workerd with a stubbed fetch. Requests are
 * signed exactly like Slack signs them (`v0=HMAC(secret, "v0:{ts}:{body}")`) with real
 * `Date.now()` timestamps (slack-edge has no clock injection).
 */

const RESPONSE_URL = "https://hooks.slack.com/actions/resp-app-1";

interface RecordedCall {
  url: string;
  body: string;
}
let recorded: RecordedCall[];

beforeEach(() => {
  recorded = [];
  const spy = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    let url: string;
    let body = "";
    if (input instanceof Request) {
      url = input.url;
      body = new TextDecoder().decode(await input.clone().arrayBuffer());
    } else {
      url = String(input); // string or URL
      body = typeof init?.body === "string" ? init.body : "";
    }
    recorded.push({ url, body });

    if (url.includes("/api/users.info")) {
      return Response.json({ ok: true, user: { is_admin: true, is_owner: false } });
    }
    if (url.includes("/api/users.profile.get")) {
      return Response.json({ ok: true, profile: { real_name: "Ada" } });
    }
    if (url.includes("zoom.us/oauth/token")) {
      return Response.json({ access_token: "zt", token_type: "bearer", expires_in: 3600 });
    }
    if (url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({
        attendees: [{ name: "Ada", join_url: "https://zoom.us/w/personal-3" }],
      });
    }
    return Response.json({ ok: true, ts: "1700000000.000100", channel: "C" });
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

function callsTo(fragment: string): RecordedCall[] {
  return recorded.filter((r) => r.url.includes(fragment));
}

/** POST a Slack-signed request through the router and drain the lazy work. */
async function post(
  path: string,
  rawBody: string,
  contentType: string,
  opts?: { secret?: string },
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = opts?.secret ?? env.SLACK_SIGNING_SECRET;
  const signature = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
  const req = new Request(`https://bots.example${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
  const ctx = createExecutionContext();
  const res = await route(req, env, ctx);
  await waitOnExecutionContext(ctx); // lazy handlers run via ctx.waitUntil
  return res;
}

function blockActionBody(actionId: string): string {
  const payload = {
    type: "block_actions",
    user: { id: "U777", username: "ada", name: "ada" },
    api_app_id: "A1",
    token: "t",
    trigger_id: "tr1",
    team: { id: "T1", domain: "vc" },
    response_url: RESPONSE_URL,
    actions: [{ type: "button", action_id: actionId, block_id: "b1", action_ts: "1" }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

describe("signature verification", () => {
  it("rejects a request signed with the wrong secret and dispatches nothing", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "team_join", user: { id: "U123" } },
    });
    const res = await post("/slack/events", body, "application/json", {
      secret: "not-the-signing-secret",
    });
    expect(res.status).toBe(401);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
  });
});

describe("url_verification handshake", () => {
  it("echoes the challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", token: "t", challenge: "ch-123" });
    const res = await post("/slack/events", body, "application/json");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ch-123");
  });
});

describe("events", () => {
  it("team_join DMs the welcome message to the new member", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event: { type: "team_join", user: { id: "U123" } },
      event_id: "Ev1",
      event_time: 1,
    });
    const res = await post("/slack/events", body, "application/json");
    expect(res.status).toBe(200);

    const posts = callsTo("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0]!.body).get("channel")).toBe("U123");
  });

  it("app_home_opened publishes the Home tab for the opener", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event: { type: "app_home_opened", user: "U456", channel: "D1", tab: "home", event_ts: "1" },
      event_id: "Ev2",
      event_time: 2,
    });
    const res = await post("/slack/events", body, "application/json");
    expect(res.status).toBe(200);

    const publishes = callsTo("/api/views.publish");
    expect(publishes).toHaveLength(1);
    expect(new URLSearchParams(publishes[0]!.body).get("user_id")).toBe("U456");
  });
});

describe("interactivity", () => {
  it("coworking_join answers with a NEW ephemeral — never replacing the shared room message", async () => {
    const res = await post(
      "/slack/interactivity",
      blockActionBody("coworking_join"),
      "application/x-www-form-urlencoded",
    );
    expect(res.status).toBe(200);

    const replies = callsTo(RESPONSE_URL);
    expect(replies).toHaveLength(1);
    const sent = JSON.parse(replies[0]!.body);
    // The channel button's response_url "original" is the shared room message: the reply
    // must be a new ephemeral for the clicker, never a replacement.
    expect(sent.response_type).toBe("ephemeral");
    expect(sent.replace_original).toBe(false);
    // The button url is the opaque /join/<token> redirect — never the raw Zoom link.
    expect(JSON.stringify(sent.attachments)).toMatch(/\/join\/[0-9a-f]{32}/);
    expect(replies[0]!.body).not.toContain("personal-3");
  });

  it("coworking_cancel deletes the per-user join ephemeral", async () => {
    const res = await post(
      "/slack/interactivity",
      blockActionBody("coworking_cancel"),
      "application/x-www-form-urlencoded",
    );
    expect(res.status).toBe(200);

    const replies = callsTo(RESPONSE_URL);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0]!.body)).toEqual({ delete_original: true });
  });
});

describe("slash command", () => {
  it("/vc-bot-admin checks the invoker is an admin and replies via response_url", async () => {
    const body = new URLSearchParams({
      command: "/vc-bot-admin",
      text: "home",
      user_id: "U1",
      channel_id: "C9",
      response_url: RESPONSE_URL,
      trigger_id: "tr2",
      team_id: "T1",
      token: "t",
      api_app_id: "A1",
    }).toString();
    const res = await post("/slack/commands", body, "application/x-www-form-urlencoded");
    expect(res.status).toBe(200);

    expect(callsTo("/api/users.info")).toHaveLength(1); // admin gate
    expect(callsTo("/api/views.publish")).toHaveLength(1); // `home` preview
    const replies = callsTo(RESPONSE_URL);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0]!.body).text).toContain("App Home");
  });
});
