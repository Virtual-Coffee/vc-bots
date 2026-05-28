import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleJoinClick, isJoinClick } from "../src/bots/coworking/join";
import type { SlackBlockActionsPayload } from "../src/slack/types";

const RESPONSE_URL = "https://hooks.slack.com/actions/resp-123";

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

    if (url.includes("/api/users.profile.get")) {
      return Response.json({ ok: true, profile: { email: "ada@example.com", real_name: "Ada" } });
    }
    if (url.includes("zoom.us/oauth/token")) {
      return Response.json({ access_token: "zt", token_type: "bearer", expires_in: 3600 });
    }
    if (url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({ registrant_id: "reg-9", join_url: "https://zoom.us/w/personal-9" });
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

function payload(): SlackBlockActionsPayload {
  return {
    type: "block_actions",
    user: { id: "U777" },
    response_url: RESPONSE_URL,
    actions: [{ action_id: "coworking_join", type: "button" }],
  };
}

describe("isJoinClick", () => {
  it("recognizes the Join button action", () => {
    expect(isJoinClick(payload())).toBe(true);
    expect(
      isJoinClick({ ...payload(), actions: [{ action_id: "something_else", type: "button" }] }),
    ).toBe(false);
  });
});

describe("handleJoinClick", () => {
  it("registers via the DO and delivers the personal link through response_url", async () => {
    await handleJoinClick(payload(), env);

    const resp = recorded.find((r) => r.url === RESPONSE_URL);
    expect(resp).toBeDefined();
    const sent = JSON.parse(resp!.body);
    expect(sent.response_type).toBe("ephemeral");
    expect(sent.text).toContain("https://zoom.us/w/personal-9");
  });
});
