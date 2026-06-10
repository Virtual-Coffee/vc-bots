import { describe, expect, it } from "vitest";
import {
  CANCEL_ACTION_ID,
  JOIN_ACTION_ID,
  JOIN_REDIRECT_ACTION_ID,
  buildJoinEphemeralAttachments,
  buildRoomClosedBlocks,
  buildRoomIdleBlocks,
  buildRoomOpenBlocks,
} from "../src/bots/coworking/slack-call";
import { formatDuration } from "../src/bots/coworking/zoom-events";
import type { Env } from "../src/env";

const env = {
  ROOM_TITLE: "Co-Working Room",
} as Env;

describe("buildRoomOpenBlocks", () => {
  it("uses the ephemeral-trigger Join button (no url) + a bulleted presence roster", () => {
    const open = buildRoomOpenBlocks(env, [{ slackUserId: "U777" }, { displayName: "Ben" }]);
    expect(open[0]?.type).toBe("header");
    const blocks = JSON.stringify(open);
    expect(blocks).toContain(JOIN_ACTION_ID); // mints the per-user join ephemeral
    expect(blocks).not.toContain(JOIN_REDIRECT_ACTION_ID);
    expect(blocks).not.toContain('"url"'); // no shared url — the link is per-user, via the ephemeral
    expect(blocks).toContain("(2)"); // presence count
    expect(blocks).toContain("rich_text_list"); // the roster is a bulleted list…
    expect(blocks).toContain('"user_id":"U777"'); // …members as real mention elements
    expect(blocks).toContain("Ben"); // …guests as plain text

    const empty = JSON.stringify(buildRoomOpenBlocks(env, []));
    expect(empty).toContain(JOIN_ACTION_ID);
    expect(empty).toMatch(/nobody/i);
    expect(empty).not.toContain("rich_text_list"); // no list when the room is empty
  });
});

describe("buildRoomIdleBlocks", () => {
  it("invites starting a session with the ephemeral-trigger Join button", () => {
    const idle = buildRoomIdleBlocks(env);
    expect(idle[0]?.type).toBe("header");
    const blocks = JSON.stringify(idle);
    expect(blocks).toContain("Start the co-working room");
    expect(blocks).toContain(JOIN_ACTION_ID);
    expect(blocks).not.toContain('"url"');
  });
});

describe("buildJoinEphemeralAttachments", () => {
  it("pairs a ☕ Join url button (the redirect, not a Zoom link) with a Cancel button", () => {
    const redirect = "https://bots.example/join/abc123abc123abc1";
    const attachments = JSON.stringify(buildJoinEphemeralAttachments(env, redirect));
    expect(attachments).toContain(JOIN_REDIRECT_ACTION_ID);
    expect(attachments).toContain(CANCEL_ACTION_ID);
    expect(attachments).toContain(redirect); // the button url is the Worker redirect…
    expect(attachments).not.toContain("zoom.us"); // …never the token-bearing Zoom url
    expect(attachments).toContain("Code of Conduct");
  });

  it("renders as one color-bar invitation: header up top, CoC fine print above the buttons", () => {
    const attachments = buildJoinEphemeralAttachments(
      env,
      "https://bots.example/join/abc123abc123abc1",
    );
    expect(attachments).toHaveLength(1);
    const invite = attachments[0];
    // The accent bar (card and alert blocks are rejected in messages — color is the standout).
    expect(invite?.color).toBe("#d9376e");
    expect(invite?.fallback).toContain(env.ROOM_TITLE);
    const types = invite?.blocks?.map((b) => b.type);
    expect(types).toEqual(["header", "section", "context", "actions"]);
  });
});

describe("buildRoomClosedBlocks", () => {
  it("summarises length, peak, and a deduped roster — no Join button", () => {
    const closed = buildRoomClosedBlocks(env, {
      durationMs: 90 * 60_000,
      peak: 3,
      attendees: [{ slackUserId: "U1" }, { displayName: "Ben" }],
    });
    expect(closed[0]?.type).toBe("header");
    const blocks = JSON.stringify(closed);
    expect(blocks).toContain("*Duration:* 1h 30m"); // session length field
    expect(blocks).toContain("*Peak:* 3"); // peak attendance field
    expect(blocks).toContain("Dropped in (2)"); // roster label + size
    expect(blocks).toContain("<@U1>"); // member mention
    expect(blocks).toContain("Ben"); // guest name
    expect(blocks).not.toContain(JOIN_ACTION_ID); // session is over
  });

  it("omits the roster line when nobody was recorded", () => {
    const blocks = JSON.stringify(
      buildRoomClosedBlocks(env, { durationMs: 30_000, peak: 0, attendees: [] }),
    );
    expect(blocks).toContain("<1m");
    expect(blocks).toContain("*Peak:* 0");
    expect(blocks).not.toContain("Dropped in");
  });
});

describe("formatDuration", () => {
  it("formats hours and minutes, dropping zero parts", () => {
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
  });
});
