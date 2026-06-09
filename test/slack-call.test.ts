import { describe, expect, it } from "vitest";
import {
  JOIN_ACTION_ID,
  JOIN_REDIRECT_ACTION_ID,
  buildRoomClosedBlocks,
  buildRoomIdleBlocks,
  buildRoomOpenBlocks,
  formatPresence,
} from "../src/bots/coworking/slack-call";
import { formatDuration } from "../src/bots/coworking/zoom-events";
import type { Env } from "../src/env";

const env = {
  ROOM_TITLE: "Co-Working Room",
} as Env;

describe("formatPresence", () => {
  it("renders members as mentions and guests as plain names", () => {
    const line = formatPresence([{ slackUserId: "U1" }, { displayName: "Ben" }]);
    expect(line).toContain("(2)");
    expect(line).toContain("<@U1>");
    expect(line).toContain("Ben");
  });

  it("nudges when the room is empty", () => {
    expect(formatPresence([])).toMatch(/nobody/i);
  });
});

describe("buildRoomOpenBlocks", () => {
  it("uses the modal-trigger Join button (no url) + a presence line", () => {
    const blocks = JSON.stringify(buildRoomOpenBlocks(env, [{ slackUserId: "U777" }]));
    expect(blocks).toContain(JOIN_ACTION_ID); // opens the per-user join modal
    expect(blocks).not.toContain(JOIN_REDIRECT_ACTION_ID);
    expect(blocks).not.toContain('"url"'); // no shared url — link is per-user, via the modal
    expect(blocks).toContain("<@U777>"); // presence list

    const empty = JSON.stringify(buildRoomOpenBlocks(env, []));
    expect(empty).toContain(JOIN_ACTION_ID);
    expect(empty).toMatch(/nobody/i);
  });
});

describe("buildRoomIdleBlocks", () => {
  it("invites starting a session with the modal-trigger Join button", () => {
    const blocks = JSON.stringify(buildRoomIdleBlocks(env));
    expect(blocks).toContain("Start the co-working room");
    expect(blocks).toContain(JOIN_ACTION_ID);
    expect(blocks).not.toContain('"url"');
  });
});

describe("buildRoomClosedBlocks", () => {
  it("summarises length, peak, and a deduped roster — no Join button", () => {
    const blocks = JSON.stringify(
      buildRoomClosedBlocks(env, {
        durationMs: 90 * 60_000,
        peak: 3,
        attendees: [{ slackUserId: "U1" }, { displayName: "Ben" }],
      }),
    );
    expect(blocks).toContain("1h 30m"); // session length
    expect(blocks).toContain("Peak 3"); // peak attendance
    expect(blocks).toContain("<@U1>"); // member mention
    expect(blocks).toContain("Ben"); // guest name
    expect(blocks).toContain("(2)"); // roster size
    expect(blocks).not.toContain(JOIN_ACTION_ID); // session is over
  });

  it("omits the roster line when nobody was recorded", () => {
    const blocks = JSON.stringify(
      buildRoomClosedBlocks(env, { durationMs: 30_000, peak: 0, attendees: [] }),
    );
    expect(blocks).toContain("<1m");
    expect(blocks).toContain("Peak 0");
    expect(blocks).not.toContain("Stopped by");
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
