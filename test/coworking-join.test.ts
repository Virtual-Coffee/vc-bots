import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANCEL_ACTION_ID,
  JOIN_REDIRECT_ACTION_ID,
  buildJoinEphemeralAttachments,
  handleJoinClick,
  handleJoinDismiss,
  type JoinActionPayload,
} from "../src/bots/coworking/join";
import { installFetchRecorder, type FetchRecorder, type RecordedCall } from "./helpers/fetch-recorder";

let fetched: FetchRecorder;

beforeEach(() => {
  fetched = installFetchRecorder({ zoomJoinUrl: "https://zoom.us/w/personal-9" });
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
  return fetched.calls.filter((r) => r.url === RESPONSE_URL);
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
    // Same routes, but the Zoom invite-link call now fails.
    fetched.respondWith((call) =>
      call.url.includes("api.zoom.us/v2/meetings/") ? new Response("nope", { status: 400 }) : undefined,
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

describe("buildJoinEphemeralAttachments", () => {
  const roomEnv = { ROOM_TITLE: "Co-Working Room" };

  it("pairs a ☕ Join url button (the redirect, not a Zoom link) with a Cancel button", () => {
    const redirect = "https://bots.example/join/abc123abc123abc1";
    const attachments = JSON.stringify(buildJoinEphemeralAttachments(roomEnv, redirect));
    expect(attachments).toContain(JOIN_REDIRECT_ACTION_ID);
    expect(attachments).toContain(CANCEL_ACTION_ID);
    expect(attachments).toContain(redirect); // the button url is the Worker redirect…
    expect(attachments).not.toContain("zoom.us"); // …never the token-bearing Zoom url
    expect(attachments).toContain("Code of Conduct");
  });

  it("renders as one color-bar invitation: header up top, CoC section above the buttons", () => {
    const attachments = buildJoinEphemeralAttachments(
      roomEnv,
      "https://bots.example/join/abc123abc123abc1",
    );
    expect(attachments).toHaveLength(1);
    const invite = attachments[0];
    // The accent bar (card and alert blocks are rejected in messages — color is the standout).
    expect(invite?.color).toBe("#d9376e");
    expect(invite?.fallback).toContain(roomEnv.ROOM_TITLE);
    const types = invite?.blocks?.map((b) => b.type);
    expect(types).toEqual(["header", "section", "section", "actions"]);
  });
});
