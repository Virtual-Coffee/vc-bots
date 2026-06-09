import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleJoinClick, isJoinClick } from "../src/bots/coworking/join";
import type { SlackBlockActionsPayload } from "../src/slack/types";

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

    if (url.includes("/api/views.open")) {
      return Response.json({ ok: true, view: { id: "V1" } });
    }
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

function payload(): SlackBlockActionsPayload {
  return {
    type: "block_actions",
    user: { id: "U777" },
    trigger_id: "T1",
    response_url: "https://hooks.slack.com/actions/resp-123",
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
  it("opens a loading modal, registers via the DO, and updates the modal with the personal link", async () => {
    await handleJoinClick(payload(), env);

    // A loading modal is opened first, using the click's trigger_id.
    const open = recorded.find((r) => r.url.includes("/api/views.open"));
    expect(open).toBeDefined();
    expect(new URLSearchParams(open!.body).get("trigger_id")).toBe("T1");

    // The minted invite link is delivered by updating that modal.
    const update = recorded.find((r) => r.url.includes("/api/views.update"));
    expect(update).toBeDefined();
    expect(new URLSearchParams(update!.body).get("view_id")).toBe("V1");
    expect(update!.body).toContain("https%3A%2F%2Fzoom.us%2Fw%2Fpersonal-9");
  });

  it("shows an error modal when registration fails", async () => {
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

        if (url.includes("/api/views.open")) return Response.json({ ok: true, view: { id: "V1" } });
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

    await handleJoinClick(payload(), env);

    const updates = recorded.filter((r) => r.url.includes("/api/views.update"));
    expect(updates.at(-1)!.body).toContain("couldn");
    expect(updates.at(-1)!.body).not.toContain("personal-9");
  });
});
