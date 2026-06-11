import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleJoinClick,
  handleJoinDismiss,
  type JoinActionPayload,
} from "../src/bots/coworking/join";

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
      return Response.json({ ok: true, profile: { real_name: "Ada" } });
    }
    if (url.includes("zoom.us/oauth/token")) {
      return Response.json({ access_token: "zt", token_type: "bearer", expires_in: 3600 });
    }
    if (url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({ attendees: [{ name: "Ada", join_url: "https://zoom.us/w/personal-9" }] });
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

const RESPONSE_URL = "https://hooks.slack.com/actions/resp-123";
const ORIGIN = "https://bots.example";

function payload(actionId = "coworking_join"): JoinActionPayload {
  return {
    user: { id: "U777" },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId }],
  };
}

function responseUrlCalls(): RecordedCall[] {
  return recorded.filter((r) => r.url === RESPONSE_URL);
}

describe("handleJoinClick", () => {
  it("registers via the DO and answers with a two-button ephemeral linking the /join redirect", async () => {
    await handleJoinClick(payload(), env, ORIGIN);

    const replies = responseUrlCalls();
    expect(replies).toHaveLength(1);
    const sent = JSON.parse(replies[0]!.body);

    // A new ephemeral for the clicker — never a replacement of the shared room message.
    expect(sent.response_type).toBe("ephemeral");
    expect(sent.replace_original).toBe(false);
    expect(sent.text).toBeTruthy(); // plain-text fallback rides alongside the attachment

    // The invitation rides in a color-bar attachment (card/alert blocks are message-invalid).
    const attachments = JSON.stringify(sent.attachments);
    expect(attachments).toContain("coworking_open_zoom"); // ☕ Join (url button)
    expect(attachments).toContain("coworking_cancel"); // Cancel
    // The button url is the Worker's opaque redirect — the raw Zoom link (and its token) never
    // reaches the Slack UI, so the hover tooltip shows a clean url.
    expect(attachments).toMatch(new RegExp(`${ORIGIN}/join/[0-9a-f]{32}`));
    expect(attachments).not.toContain("personal-9");
  });

  it("answers with an error ephemeral when registration fails", async () => {
    // Re-stub: same routes, but the Zoom invite-link call now fails.
    recorded = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { body?: unknown }) => {
        const url = input instanceof Request ? input.url : String(input);
        const body =
          input instanceof Request
            ? new TextDecoder().decode(await input.clone().arrayBuffer())
            : typeof init?.body === "string"
              ? init.body
              : "";
        recorded.push({ url, body });

        if (url.includes("/api/users.profile.get")) {
          return Response.json({ ok: true, profile: { real_name: "Ada" } });
        }
        if (url.includes("zoom.us/oauth/token")) {
          return Response.json({ access_token: "zt", token_type: "bearer", expires_in: 3600 });
        }
        if (url.includes("api.zoom.us/v2/meetings/")) return new Response("nope", { status: 400 });
        return Response.json({ ok: true });
      }),
    );

    await handleJoinClick(payload(), env, ORIGIN);

    const replies = responseUrlCalls();
    expect(replies).toHaveLength(1);
    const sent = JSON.parse(replies[0]!.body);
    expect(sent.response_type).toBe("ephemeral");
    expect(sent.text).toContain("couldn");
    expect(replies[0]!.body).not.toContain("personal-9");
  });
});

describe("handleJoinDismiss", () => {
  it("deletes the ephemeral the click came from", async () => {
    await handleJoinDismiss(payload("coworking_cancel"), env);

    const replies = responseUrlCalls();
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0]!.body)).toEqual({ delete_original: true });
  });
});
