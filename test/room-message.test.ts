import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOIN_ACTION_ID,
  RoomMessage,
  type SessionStats,
} from "../src/bots/coworking/room-message";
import { JOIN_REDIRECT_ACTION_ID } from "../src/bots/coworking/join";
import {
  createFakeRoomChannelPort,
  createMemoryStorage,
  type FakeRoomChannelPort,
} from "./helpers/room-channel-fake";

/**
 * `RoomMessage` against the fake channel port and a Map-backed storage: the card layouts, the
 * standing-invite hand-off between cards, announcements, and vanished-message handling. The
 * Slack adapter and the DO's session state machine are covered end-to-end in coworking-do.test.ts.
 */

const env = { ROOM_TITLE: "Co-Working Room" };
const STARTED_AT = Date.parse("2026-07-28T13:03:00Z");
const ENDED_AT = Date.parse("2026-07-28T14:33:00Z");
const NOW = Date.parse("2026-07-28T15:00:00Z");

/** Storage keys RoomMessage owns (the first two predate the module and carry over from a deployed DO). */
const LAST_CLOSED_KEY = "last_closed_message";
const LEGACY_KEY = "idle_invite_ts";

let port: FakeRoomChannelPort;
let storage: ReturnType<typeof createMemoryStorage>;
let room: RoomMessage;

beforeEach(() => {
  port = createFakeRoomChannelPort();
  storage = createMemoryStorage();
  room = new RoomMessage(port, storage, env);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return { durationMs: 90 * 60_000, peak: 3, attendees: [], ...overrides };
}

/** Section fields of a card with the date tokens masked, so the 2×2 grid can be asserted in order. */
function fieldsOf(blocks: { type: string; fields?: { text?: string }[] }[]): string[] {
  return blocks
    .flatMap((b) => (b.type === "section" && b.fields ? b.fields : []))
    .map((f) => f.text?.replace(/<!date\^\d+\^[^>]+>/, "<time>") ?? "");
}

describe("the open card", () => {
  it("has the ephemeral-trigger Join button (no url) and a bulleted presence roster", async () => {
    const ts = (await room.open(STARTED_AT))!;
    await room.showPresence(ts, [{ slackUserId: "U777" }, { displayName: "Ben" }], STARTED_AT);

    const open = port.updates.at(-1)!.blocks;
    expect(open[0]?.type).toBe("header");
    const json = JSON.stringify(open);
    expect(json).toContain(JOIN_ACTION_ID); // mints the per-user join ephemeral
    expect(json).not.toContain(JOIN_REDIRECT_ACTION_ID);
    expect(json).not.toContain('"url"'); // no shared url — the link is per-user, via the ephemeral
    expect(json).toContain("(2)"); // presence count
    expect(json).toContain("rich_text_list"); // the roster is a bulleted list…
    expect(json).toContain('"user_id":"U777"'); // …members as real mention elements
    expect(json).toContain("Ben"); // …guests as plain text
    expect(port.updates.at(-1)!.text).toContain("is now open");
  });

  it("nudges when the room is empty, with no list", async () => {
    await room.open(STARTED_AT);
    const empty = port.lastPostJson();
    expect(empty).toContain(JOIN_ACTION_ID);
    expect(empty).toMatch(/nobody/i);
    expect(empty).not.toContain("rich_text_list");
  });

  it("shows the session start time as a per-viewer date token, above the Join button", async () => {
    await room.open(STARTED_AT);

    const open = port.posts.at(-1)!.blocks;
    const json = JSON.stringify(open);
    // {time} only — the ended card covers the date/duration side.
    expect(json).toMatch(/<!date\^\d+\^\{time\}\|/); // integer token, per-viewer timezone
    expect(json).toContain(String(Math.floor(STARTED_AT / 1000)));
    expect(json).toContain("Session started at");

    // Session status reads before the call to action.
    const contextIdx = open.findIndex((b) => JSON.stringify(b).includes("Session started at"));
    const actionsIdx = open.findIndex((b) => b.type === "actions");
    expect(contextIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(actionsIdx);
  });

  it("omits the start line when there's no session behind it (an announcement, a null started_at)", async () => {
    await room.announceOpen();
    expect(port.lastPostJson()).not.toContain("<!date");

    const ts = (await room.open(STARTED_AT))!;
    await room.showPresence(ts, [], null); // updatePresence passes a nullable column
    expect(port.lastUpdateJson()).not.toContain("<!date");
  });

  it("returns null (and posts nothing usable) when Slack answers without a ts", async () => {
    port.postWithoutTs = true;
    expect(await room.open(STARTED_AT)).toBeNull();
  });
});

describe("the ended card", () => {
  it("summarises length, peak, and a deduped roster, then invites the next session", async () => {
    await room.close("ts-1", stats({ attendees: [{ slackUserId: "U1" }, { displayName: "Ben" }] }));

    const closed = port.updates.at(-1)!.blocks;
    expect(closed[0]?.type).toBe("header");
    const json = JSON.stringify(closed);
    expect(json).toContain("That's a wrap");
    expect(json).toContain("*Duration:* 1h 30m"); // session length field
    expect(json).toContain("*Peak:* 3"); // peak attendance field
    expect(json).toContain("Dropped in (2)"); // roster label + size
    expect(json).toContain("<@U1>"); // member mention
    expect(json).toContain("Ben"); // guest name
    // The ended card doubles as the standing invite, so the next session starts from here.
    expect(json).toContain("Start the co-working room");
    expect(json).toContain(JOIN_ACTION_ID);
    expect(json).not.toContain('"url"'); // per-user link comes from the ephemeral, not the button
    expect(closed.at(-1)?.type).toBe("actions"); // the invite closes out the card
    expect(closed.at(-2)?.type).toBe("section"); // …under its nudge line
    expect(closed.at(-3)?.type).toBe("divider"); // …separated from the stats
    expect(port.updates.at(-1)!.text).toContain("session has ended");
  });

  it("drops the invite when retired by a newer room message, keeping the stats", async () => {
    await room.close("ts-1", stats({ attendees: [{ slackUserId: "U1" }] }));
    await room.retirePrevious();

    const retired = port.updates.at(-1)!;
    expect(retired.ts).toBe("ts-1");
    const json = JSON.stringify(retired.blocks);
    expect(json).toContain("*Duration:* 1h 30m"); // the stats stay in channel history…
    expect(json).toContain("Dropped in (1)");
    expect(json).not.toContain(JOIN_ACTION_ID); // …only the standing invite moves on
    expect(json).not.toContain("Start the co-working room");
    expect(json).not.toContain("divider");
  });

  it("omits the roster line when nobody was recorded", async () => {
    await room.close("ts-1", stats({ durationMs: 30_000, peak: 0 }));
    const json = port.lastUpdateJson();
    expect(json).toContain("<1m");
    expect(json).toContain("*Peak:* 0");
    expect(json).not.toContain("Dropped in");
  });

  it("bookends the summary with Started/Ended date tokens ahead of Duration/Peak", async () => {
    await room.close("ts-1", stats({ startedAtMs: STARTED_AT, endedAtMs: ENDED_AT }));

    // Slack flows fields into two columns in order, so this order is what makes the 2×2 grid.
    expect(fieldsOf(port.updates.at(-1)!.blocks)).toEqual([
      ":clock3: *Started:* <time>",
      ":checkered_flag: *Ended:* <time>",
      ":stopwatch: *Duration:* 1h 30m",
      ":busts_in_silhouette: *Peak:* 3",
    ]);
    const json = port.lastUpdateJson();
    expect(json).toContain(String(Math.floor(STARTED_AT / 1000)));
    expect(json).toContain(String(Math.floor(ENDED_AT / 1000)));
  });

  it("falls back to the Duration/Peak row when the session has no recorded start", async () => {
    // started_at is nullable in the DO schema — the same reason durationMs degrades to 0.
    await room.close("ts-1", stats({ startedAtMs: null, endedAtMs: null, durationMs: 0, peak: 0 }));
    expect(fieldsOf(port.updates.at(-1)!.blocks)).toHaveLength(2);
    expect(port.lastUpdateJson()).not.toContain("<!date");
  });

  it("formats the duration as hours and minutes, dropping zero parts", async () => {
    const cases: [number, string][] = [
      [0, "<1m"],
      [30_000, "<1m"],
      [45 * 60_000, "45m"],
      [60 * 60_000, "1h"],
      [90 * 60_000, "1h 30m"],
    ];
    for (const [durationMs, rendered] of cases) {
      await room.close("ts-1", stats({ durationMs }));
      expect(port.lastUpdateJson()).toContain(`*Duration:* ${rendered}`);
    }
  });
});

describe("the standing invite", () => {
  it("close remembers the ended card; retirePrevious strips its invite once and forgets it", async () => {
    await room.close("ts-1", stats());
    expect(storage.map.get(LAST_CLOSED_KEY)).toMatchObject({ ts: "ts-1" });

    await room.retirePrevious();
    expect(port.updates).toHaveLength(2);
    expect(port.updates[1]!.ts).toBe("ts-1");
    expect(port.lastUpdateJson()).not.toContain(JOIN_ACTION_ID);
    expect(storage.map.has(LAST_CLOSED_KEY)).toBe(false);

    // Nothing left to retire — a second start doesn't touch the old card again.
    await room.retirePrevious();
    expect(port.updates).toHaveLength(2);
  });

  it("does not remember a card that vanished before it could be closed", async () => {
    port.vanish("ts-1");
    await room.close("ts-1", stats());
    expect(port.updates.at(-1)!.result).toBe("vanished");
    expect(storage.map.has(LAST_CLOSED_KEY)).toBe(false);

    await room.retirePrevious();
    expect(port.updates).toHaveLength(1); // nothing to retire
  });

  it("showPresence on a vanished card just skips (the join webhook must not throw)", async () => {
    port.vanish("ts-1");
    await expect(room.showPresence("ts-1", [{ displayName: "Ada" }], STARTED_AT)).resolves.toBeUndefined();
    expect(port.updates.at(-1)!.result).toBe("vanished");
  });

  it("retirePrevious still clears the pointer when the ended card has vanished", async () => {
    await room.close("ts-1", stats());
    port.vanish("ts-1");
    await room.retirePrevious();
    expect(storage.map.has(LAST_CLOSED_KEY)).toBe(false);
  });
});

describe("announcements", () => {
  it("announceOpen posts an open card with no presence and no start line", async () => {
    await room.announceOpen();
    expect(port.posts).toHaveLength(1);
    const json = port.lastPostJson();
    expect(json).toContain(JOIN_ACTION_ID);
    expect(json).toMatch(/nobody/i);
    expect(json).not.toContain("Session started at");
  });

  it("announceClose renders the full ended card with the invite and makes it the last closed card", async () => {
    vi.spyOn(Date, "now").mockReturnValue(STARTED_AT);
    await room.announceOpen();
    const announcementTs = port.posts[0]!.ts;

    vi.spyOn(Date, "now").mockReturnValue(ENDED_AT);
    expect(await room.announceClose()).toEqual({ closed: true });

    const closed = port.updates.at(-1)!;
    expect(closed.ts).toBe(announcementTs);
    const json = JSON.stringify(closed.blocks);
    expect(json).toContain("That's a wrap");
    expect(json).toContain("*Peak:* 0");
    expect(json).not.toContain("Dropped in"); // no session, no roster
    expect(json).toContain(JOIN_ACTION_ID); // carries the standing invite like any ended card
    expect(fieldsOf(closed.blocks)).toEqual([
      ":clock3: *Started:* <time>",
      ":checkered_flag: *Ended:* <time>",
      ":stopwatch: *Duration:* 1h 30m",
      ":busts_in_silhouette: *Peak:* 0",
    ]);
    expect(json).toContain(String(Math.floor(STARTED_AT / 1000)));
    expect(json).toContain(String(Math.floor(ENDED_AT / 1000)));

    // The next room message retires it exactly like a session's ended card.
    await room.retirePrevious();
    const retired = port.updates.at(-1)!;
    expect(retired.ts).toBe(announcementTs);
    expect(JSON.stringify(retired.blocks)).not.toContain(JOIN_ACTION_ID);
    expect(await room.announceClose()).toEqual({ closed: false }); // pointer spent
  });

  it("retirePrevious closes a lingering open announcement without the invite", async () => {
    vi.spyOn(Date, "now").mockReturnValue(STARTED_AT);
    await room.announceOpen();
    const announcementTs = port.posts[0]!.ts;

    vi.spyOn(Date, "now").mockReturnValue(ENDED_AT);
    await room.retirePrevious(); // a session started while the announcement was still open

    const closed = port.updates.at(-1)!;
    expect(closed.ts).toBe(announcementTs);
    const json = JSON.stringify(closed.blocks);
    expect(json).toContain("That's a wrap");
    expect(json).not.toContain(JOIN_ACTION_ID);
    expect(json).not.toContain("Dropped in");
    expect(json).toContain(String(Math.floor(STARTED_AT / 1000))); // announced-at as Started
    expect(json).toContain(String(Math.floor(ENDED_AT / 1000))); // now as Ended
    expect(await room.announceClose()).toEqual({ closed: false }); // pointer cleared
  });

  it("a second announceOpen closes the first and takes over", async () => {
    await room.announceOpen();
    const first = port.posts[0]!.ts;
    await room.announceOpen();

    expect(port.posts).toHaveLength(2);
    const closedFirst = port.updates.at(-1)!;
    expect(closedFirst.ts).toBe(first);
    expect(JSON.stringify(closedFirst.blocks)).toContain("That's a wrap");
    expect(JSON.stringify(closedFirst.blocks)).not.toContain(JOIN_ACTION_ID);

    // Only the second is open now: closing edits it, not the first.
    expect(await room.announceClose()).toEqual({ closed: true });
    expect(port.updates.at(-1)!.ts).toBe(port.posts[1]!.ts);
  });

  it("announceOpen retires the previous session's ended card first", async () => {
    await room.close("ts-1", stats());
    await room.announceOpen();

    const retired = port.updates.at(-1)!;
    expect(retired.ts).toBe("ts-1");
    expect(JSON.stringify(retired.blocks)).not.toContain(JOIN_ACTION_ID);
    expect(port.posts).toHaveLength(1);
  });

  it("announceClose is a no-op with nothing announced", async () => {
    expect(await room.announceClose()).toEqual({ closed: false });
    expect(port.updates).toHaveLength(0);
  });

  it("treats a vanished announcement as nothing to close and forgets it", async () => {
    await room.announceOpen();
    port.vanish(port.posts[0]!.ts);

    expect(await room.announceClose()).toEqual({ closed: false });
    expect(storage.map.has(LAST_CLOSED_KEY)).toBe(false); // nothing to carry the invite
    expect(await room.announceClose()).toEqual({ closed: false }); // pointer spent, no retry
    expect(port.updates).toHaveLength(1);
  });

  it("announceOpen remembers nothing when Slack answers without a ts", async () => {
    port.postWithoutTs = true;
    await room.announceOpen();
    expect(await room.announceClose()).toEqual({ closed: false });
  });
});

describe("legacy standing-invite cleanup", () => {
  it("deletes the retired lifecycle's message once and forgets the pointer", async () => {
    await storage.put(LEGACY_KEY, "1699999999.000001");

    await room.retirePrevious();
    expect(port.deletes).toEqual(["1699999999.000001"]);
    expect(storage.map.has(LEGACY_KEY)).toBe(false);

    await room.retirePrevious();
    expect(port.deletes).toHaveLength(1); // one-shot
  });

  it("swallows a failed delete but still forgets the pointer", async () => {
    await storage.put(LEGACY_KEY, "1699999999.000001");
    port.deleteError = new Error("message_not_found");

    await expect(room.retirePrevious()).resolves.toBeUndefined();
    expect(storage.map.has(LEGACY_KEY)).toBe(false);
  });
});
