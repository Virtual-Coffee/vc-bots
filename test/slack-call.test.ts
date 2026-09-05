import { describe, expect, it } from "vitest";
import { JOIN_REDIRECT_ACTION_ID } from "../src/bots/coworking/join";
import {
  JOIN_ACTION_ID,
  buildRoomClosedBlocks,
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

  it("shows the session start time as a per-viewer date token, above the Join button", () => {
    const startedAt = Date.parse("2026-07-28T13:03:00Z");
    const open = buildRoomOpenBlocks(env, [], startedAt);

    const json = JSON.stringify(open);
    // {time} only — the ended summary covers the date/duration side.
    expect(json).toMatch(/<!date\^\d+\^\{time\}\|/); // integer token, per-viewer timezone
    expect(json).toContain(String(Math.floor(startedAt / 1000)));
    expect(json).toContain("Session started at");

    // Session status reads before the call to action.
    const contextIdx = open.findIndex((b) => JSON.stringify(b).includes("Session started at"));
    const actionsIdx = open.findIndex((b) => b.type === "actions");
    expect(contextIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(actionsIdx);
  });

  it("omits the start line when there's no tracked session (the admin announce path)", () => {
    // Both the omitted and explicitly-null cases — updatePresence passes a nullable column.
    expect(JSON.stringify(buildRoomOpenBlocks(env, []))).not.toContain("<!date");
    expect(JSON.stringify(buildRoomOpenBlocks(env, [], null))).not.toContain("<!date");
  });
});

describe("buildRoomClosedBlocks", () => {
  it("summarises length, peak, and a deduped roster, then invites the next session", () => {
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
    // The ended card doubles as the standing invite, so the next session starts from here.
    expect(blocks).toContain("Start the co-working room");
    expect(blocks).toContain(JOIN_ACTION_ID);
    expect(blocks).not.toContain('"url"'); // per-user link comes from the ephemeral, not the button
    expect(closed.at(-1)?.type).toBe("actions"); // the CTA closes out the card
    expect(closed.at(-2)?.type).toBe("section"); // …under its nudge line
    expect(closed.at(-3)?.type).toBe("divider"); // …separated from the stats
  });

  it("drops the CTA when the card is retired by a newer session", () => {
    const stats = {
      durationMs: 90 * 60_000,
      peak: 3,
      attendees: [{ slackUserId: "U1" }],
    };
    const retired = JSON.stringify(buildRoomClosedBlocks(env, stats, { invite: false }));
    expect(retired).toContain("*Duration:* 1h 30m"); // the stats stay in channel history…
    expect(retired).toContain("Dropped in (1)");
    expect(retired).not.toContain(JOIN_ACTION_ID); // …only the live CTA moves on
    expect(retired).not.toContain("Start the co-working room");
    expect(retired).not.toContain("divider");
  });

  it("omits the roster line when nobody was recorded", () => {
    const blocks = JSON.stringify(
      buildRoomClosedBlocks(env, { durationMs: 30_000, peak: 0, attendees: [] }),
    );
    expect(blocks).toContain("<1m");
    expect(blocks).toContain("*Peak:* 0");
    expect(blocks).not.toContain("Dropped in");
  });

  it("bookends the summary with Started/Ended date tokens ahead of Duration/Peak", () => {
    const startedAtMs = Date.parse("2026-07-28T13:03:00Z");
    const endedAtMs = Date.parse("2026-07-28T14:33:00Z");
    const closed = buildRoomClosedBlocks(env, {
      startedAtMs,
      endedAtMs,
      durationMs: 90 * 60_000,
      peak: 3,
      attendees: [],
    });

    // Slack flows fields into two columns in order, so this order is what makes the 2×2 grid.
    const fields = closed.flatMap((b) => (b.type === "section" && b.fields ? b.fields : []));
    expect(fields.map((f) => f.text?.replace(/<!date\^\d+\^[^>]+>/, "<time>"))).toEqual([
      ":clock3: *Started:* <time>",
      ":checkered_flag: *Ended:* <time>",
      ":stopwatch: *Duration:* 1h 30m",
      ":busts_in_silhouette: *Peak:* 3",
    ]);
    const json = JSON.stringify(closed);
    expect(json).toContain(String(Math.floor(startedAtMs / 1000)));
    expect(json).toContain(String(Math.floor(endedAtMs / 1000)));
  });

  it("falls back to the Duration/Peak row when the session has no recorded start", () => {
    // started_at is nullable in the DO schema — the same reason durationMs degrades to 0.
    const closed = buildRoomClosedBlocks(env, {
      startedAtMs: null,
      endedAtMs: null,
      durationMs: 0,
      peak: 0,
      attendees: [],
    });
    const fields = closed.flatMap((b) => (b.type === "section" && b.fields ? b.fields : []));
    expect(fields).toHaveLength(2);
    expect(JSON.stringify(closed)).not.toContain("<!date");
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
