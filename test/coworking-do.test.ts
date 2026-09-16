import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoworkingRoom } from "../src/bots/coworking/durable-object";
import type { ZoomMeetingEvent, ZoomMeetingEventType } from "../src/zoom/types";
import { createInviteLinkFake, type FakeInviteLinks, installInviteLinkFake } from "./helpers/invite-link-fake";
import {
  createFakeRoomChannelPort,
  type FakeRoomChannelPort,
  installRoomChannelFake,
} from "./helpers/room-channel-fake";

/**
 * The co-working room's session state machine: the real DO (SQLite, alarm, join tokens) driven
 * through `runInDurableObject`, with its two ports swapped for in-memory fakes on every entry (a
 * DO may be re-instantiated between calls, so the swap is repeated rather than done once): the
 * room channel (`test/helpers/room-channel-fake.ts`) and the invite-link mint
 * (`test/helpers/invite-link-fake.ts`). No fetch, no Slack, no Zoom. Card layouts and the
 * standing-invite pointer transitions are covered in room-message.test.ts; this suite asserts
 * the session rows and which message the DO told RoomMessage to post / edit / delete.
 */

let port: FakeRoomChannelPort;
let inviteFake: FakeInviteLinks;

beforeEach(() => {
  port = createFakeRoomChannelPort();
  inviteFake = createInviteLinkFake();
  // Nothing here may reach the network: a fetch means a fake wasn't installed.
  vi.stubGlobal("fetch", () => {
    throw new Error("coworking-do.test.ts: unexpected fetch — a port fake is missing");
  });
});
afterEach(() => vi.unstubAllGlobals());

// --- helpers ---

interface ParticipantInput {
  user_id: string;
  user_name: string;
}

function event(type: ZoomMeetingEventType, uuid: string, participant?: ParticipantInput) {
  return eventAt(type, uuid, 1_700_000_000_000, participant);
}

/** Like `event`, but with an explicit `event_ts` (ms) so tests can produce real durations. */
function eventAt(
  type: ZoomMeetingEventType,
  uuid: string,
  tsMs: number,
  participant?: ParticipantInput,
): ZoomMeetingEvent {
  return {
    event: type,
    event_ts: tsMs,
    payload: { object: { id: "4669259563", uuid, ...(participant ? { participant } : {}) } },
  };
}

function room(name: string) {
  return env.COWORKING_ROOM.getByName(name);
}
type RoomStub = ReturnType<typeof room>;

/**
 * Run a callback against the live CoworkingRoom instance with both fakes installed. The
 * test-env binding type isn't narrowed to `CoworkingRoom`, so we cast the instance for the
 * callback — `runInDurableObject` hands back the real object either way.
 */
function withRoom<T>(
  stub: RoomStub,
  fn: (instance: CoworkingRoom, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, (instance, state) => {
    const live = instance as unknown as CoworkingRoom;
    installRoomChannelFake(live, port);
    installInviteLinkFake(live, inviteFake);
    return fn(live, state);
  });
}

const send = (stub: RoomStub, ev: ZoomMeetingEvent) =>
  withRoom(stub, (live) => live.handleZoomEvent(ev));
const join = (stub: RoomStub, input: { slackUserId: string; displayName: string }) =>
  withRoom(stub, (live) => live.handleJoinRequest(input));

/** ts of the n-th message the bot posted — every session start / announcement is its own. */
const postedTs = (n: number) => port.posts[n]!.ts;
/** The `ts` of the most recent update — which card was edited last. */
const lastUpdatedTs = () => port.updates.at(-1)!.ts;

async function sessions(stub: RoomStub) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql.exec("SELECT * FROM session").toArray(),
  );
}
async function participants(stub: RoomStub) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql.exec("SELECT * FROM participant").toArray(),
  );
}

// --- tests ---

describe("CoworkingRoom — room message lifecycle", () => {
  it("meeting.started posts an open card", async () => {
    const stub = room("m1");
    await send(stub, event("meeting.started", "uuid-1"));

    expect(port.posts).toHaveLength(1);
    expect(port.lastPostJson()).toContain("coworking_join"); // the Join button

    const rows = await sessions(stub);
    expect(rows[0]?.status).toBe("active");
  });

  it("is idempotent for duplicate meeting.started", async () => {
    const stub = room("m2");
    await send(stub, event("meeting.started", "uuid-1"));
    await send(stub, event("meeting.started", "uuid-1"));
    expect(port.posts).toHaveLength(1);
  });

  it("posts a NEW message for every session start so the channel gets notified", async () => {
    const stub = room("life1");
    await send(stub, event("meeting.started", "uuid-1"));
    await send(stub, event("meeting.ended", "uuid-1"));
    await send(stub, event("meeting.started", "uuid-2"));

    // One post per start — the previous session's card is never edited back into an open card,
    // because an edit is silent and wouldn't notify the channel.
    expect(port.posts).toHaveLength(2);
    const open = port.lastPostJson();
    expect(open).toContain("coworking_join");
    // The open card carries the session start time, from the meeting.started event ts.
    expect(open).toContain("Session started at <!date^1700000000^{time}|");

    // The new session tracks its own message, not the previous one.
    const rows = await sessions(stub);
    expect(rows.find((r) => r.instance_uuid === "uuid-2")?.slack_message_ts).toBe(postedTs(1));
    expect(rows.find((r) => r.instance_uuid === "uuid-1")?.slack_message_ts).toBe(postedTs(0));
  });

  it("hands the standing invite to the ended card, then retires it on the next start", async () => {
    const stub = room("cta1");
    await send(stub, event("meeting.started", "uuid-1"));
    await send(stub, event("meeting.ended", "uuid-1"));

    // The ended card IS the standing invite — no separate invite message is posted.
    expect(port.posts).toHaveLength(1);
    const closed = port.lastUpdateJson();
    expect(closed).toContain("session has ended");
    expect(closed).toContain("coworking_join");

    await send(stub, event("meeting.started", "uuid-2"));

    // The old card keeps its stats but loses its button, so only one standing invite exists.
    expect(lastUpdatedTs()).toBe(postedTs(0));
    const retired = port.lastUpdateJson();
    expect(retired).toContain("session has ended");
    expect(retired).not.toContain("coworking_join");
  });

  it("deletes the standing invite left over from the retired lifecycle", async () => {
    const stub = room("legacy1");
    const legacyTs = "1699999999.000001";
    await runInDurableObject(stub, async (_i, state) =>
      state.storage.put("idle_invite_ts", legacyTs),
    );

    await send(stub, event("meeting.started", "uuid-1"));

    expect(port.deletes).toEqual([legacyTs]);
    expect(
      await runInDurableObject(stub, (_i, state) => state.storage.get("idle_invite_ts")),
    ).toBeUndefined();
  });

  it("a start with a new uuid force-closes a stale session instead of wedging the room", async () => {
    const stub = room("dbl1");
    await send(stub, event("meeting.started", "uuid-1")); // post #1
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    // uuid-1's meeting.ended was never received; a new instance starts. One meeting ID can only
    // have one live instance, so uuid-1 is necessarily stale — close it and open uuid-2 now
    // rather than dropping the start and waiting for the 18h stale-session alarm.
    await send(stub, event("meeting.started", "uuid-2"));

    const rows = await sessions(stub);
    expect(rows.find((r) => r.instance_uuid === "uuid-1")?.status).toBe("ended");
    expect(rows.find((r) => r.instance_uuid === "uuid-2")?.status).toBe("active");

    // The stale session got its ended card, and uuid-2 opened as its own new message (post #2).
    const endedCard = port.updates.some((u) =>
      JSON.stringify(u.blocks).includes("session has ended"),
    );
    expect(endedCard).toBe(true);
    expect(port.posts).toHaveLength(2);
    // uuid-1's card is the last thing edited — retired, so its invite is gone.
    expect(port.lastUpdateJson()).not.toContain("coworking_join");

    // The wedge is gone: a join on the new instance lands and shows up in presence.
    await send(
      stub,
      event("meeting.participant_joined", "uuid-2", { user_id: "p2", user_name: "Bob" }),
    );
    expect(port.lastUpdateJson()).toContain("Bob");
  });

  it("recovers after a missed meeting.ended: the alarm closes and leaves a usable invite", async () => {
    const stub = room("miss1");
    await send(stub, event("meeting.started", "uuid-1")); // post #1
    // meeting.ended never arrives → the stale-session alarm force-closes it. The ended card
    // carries the invite, so no extra message is needed to keep the room reachable.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(port.posts).toHaveLength(1);
    expect(port.lastUpdateJson()).toContain("coworking_join");

    // The next session opens as its own message and retires the alarm-closed card.
    await send(stub, event("meeting.started", "uuid-2"));
    expect(port.posts).toHaveLength(2);
    expect(lastUpdatedTs()).toBe(postedTs(0));
  });

  it("posts the ended card with session length, peak attendance, and a deduped roster", async () => {
    const stub = room("stats1");
    await join(stub, { slackUserId: "U777", displayName: "Ada" }); // member link

    const t0 = 1_700_000_000_000;
    await send(stub, eventAt("meeting.started", "uuid-1", t0));
    // Ada (member) and Bob (guest) overlap → peak 2.
    await send(
      stub,
      eventAt("meeting.participant_joined", "uuid-1", t0 + 60_000, { user_id: "p1", user_name: "Ada" }),
    );
    await send(
      stub,
      eventAt("meeting.participant_joined", "uuid-1", t0 + 120_000, { user_id: "p2", user_name: "Bob" }),
    );
    await send(
      stub,
      eventAt("meeting.participant_left", "uuid-1", t0 + 180_000, { user_id: "p1", user_name: "Ada" }),
    );
    // Ends 90 minutes after it started.
    await send(stub, eventAt("meeting.ended", "uuid-1", t0 + 90 * 60_000));

    // The ended card is the close update — the last edit of the session's own message.
    const ended = port.lastUpdateJson();
    expect(ended).toContain("session has ended");
    expect(ended).toContain("1h 30m"); // total session length
    expect(ended).toContain("*Peak:* 2"); // peak concurrent attendance (section field)
    // Session bookends, threaded from session.started_at + the ended event's ts.
    expect(ended).toContain(`*Started:* <!date^${t0 / 1000}^{time}|`);
    expect(ended).toContain(`*Ended:* <!date^${(t0 + 90 * 60_000) / 1000}^{time}|`);
    // Deduped roster: Ada as a member mention, Bob as a guest name — both retained though Ada left.
    expect(ended).toContain("<@U777>");
    expect(ended).toContain("Bob");
    expect(ended).toContain("(2)");
  });

  it("meeting.ended closes the message in place and clears participants", async () => {
    const stub = room("m3");
    await send(stub, event("meeting.started", "uuid-1")); // open card
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    await send(stub, event("meeting.ended", "uuid-1"));

    // The last update is the "session has ended" close, and it carries the standing invite.
    expect(port.lastUpdateJson()).toContain("session has ended");
    expect(port.lastUpdateJson()).toContain("coworking_join");
    // A whole session is exactly one posted message.
    expect(port.posts).toHaveLength(1);

    const rows = await sessions(stub);
    expect(rows[0]?.status).toBe("ended");
    expect(await participants(stub)).toHaveLength(0);
  });
});

describe("CoworkingRoom — participant correlation & presence", () => {
  it("shows an unmatched participant as a guest", async () => {
    const stub = room("c1");
    await send(stub, event("meeting.started", "uuid-1"));
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Guest" }),
    );

    // The presence list shows the guest by display name (no mention).
    const presence = port.lastUpdateJson();
    expect(presence).toContain("Guest");
    expect(presence).not.toContain('"user_id"'); // no mention element — guests are plain text

    const parts = await participants(stub);
    expect(parts[0]?.slack_user_id).toBeNull();
    expect(parts[0]?.external_id).toBe("p1");
  });

  it("maps a member to their slack_id by name and @-mentions them", async () => {
    const stub = room("c2");
    // Member clicks Join first → slack_user_id ↔ display_name recorded.
    const { token } = await join(stub, { slackUserId: "U777", displayName: "Ada" });
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    await send(stub, event("meeting.started", "uuid-1"));
    // No registrant_id on an invite-link join — correlation matches the baked-in name.
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    expect(port.lastUpdateJson()).toContain('"user_id":"U777"'); // rich-text mention
    const parts = await participants(stub);
    expect(parts[0]?.slack_user_id).toBe("U777");
    expect(parts[0]?.external_id).toBeNull();
  });

  it("falls back to a plain-named guest when the Zoom name doesn't match any member", async () => {
    const stub = room("c2b");
    await join(stub, { slackUserId: "U777", displayName: "Ada Lovelace" });

    await send(stub, event("meeting.started", "uuid-1"));
    // Signed-in member overrode the pre-filled name → no match → shown as a guest by that name.
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "ada (iPhone)" }),
    );

    const presence = port.lastUpdateJson();
    expect(presence).toContain("ada (iPhone)");
    expect(presence).not.toContain("U777");
    expect((await participants(stub))[0]?.slack_user_id).toBeNull();
  });

  it("is idempotent for duplicate participant_joined", async () => {
    const stub = room("c3");
    await send(stub, event("meeting.started", "uuid-1"));
    const joined = event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" });
    await send(stub, joined);
    await send(stub, joined);

    expect(await participants(stub)).toHaveLength(1);
    // The presence list shows Ada exactly once.
    const presence = port.lastUpdateJson();
    expect(presence.split("Ada").length - 1).toBe(1);
  });

  it("participant_left drops the person from the presence list", async () => {
    const stub = room("c4");
    await send(stub, event("meeting.started", "uuid-1"));
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    await send(
      stub,
      event("meeting.participant_left", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    // The row is soft-deleted (retained for the roster) but marked as left.
    const parts = await participants(stub);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.left_at).not.toBeNull();
    // The latest presence update no longer lists Ada (empty-room nudge instead).
    const presence = port.lastUpdateJson();
    expect(presence).not.toContain("Ada");
    expect(presence.toLowerCase()).toContain("nobody");
  });

  it("drops a participant_joined with no active session (race-safe)", async () => {
    const stub = room("c5");
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    expect(await participants(stub)).toHaveLength(0);
    expect(port.updates).toHaveLength(0);
  });
});

describe("CoworkingRoom — handleJoinRequest", () => {
  it("mints an invite link, stores the slack_user_id ↔ name mapping, and returns an opaque token", async () => {
    const stub = room("j1");
    const { token } = await join(stub, { slackUserId: "U1", displayName: "Xavier" });

    // The raw join_url never leaves the DO — callers only get the join token.
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(inviteFake.mints).toEqual(["Xavier"]); // the name Zoom pre-fills, nothing else
    const links = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM member_link").toArray(),
    );
    expect(links[0]?.slack_user_id).toBe("U1");
    expect(links[0]?.display_name).toBe("Xavier");
  });

  it("resolveJoinToken round-trips the token to the personal join url", async () => {
    const stub = room("j3");
    inviteFake.joinUrl = "https://zoom.us/w/personal-X";
    const { token } = await join(stub, { slackUserId: "U1", displayName: "Xavier" });

    expect(await withRoom(stub, (live) => live.resolveJoinToken(token))).toEqual({
      joinUrl: "https://zoom.us/w/personal-X",
    });
    expect(await withRoom(stub, (live) => live.resolveJoinToken("0".repeat(32)))).toBeNull(); // unknown token
  });

  it("expires tokens and sweeps expired rows on the next mint", async () => {
    const stub = room("j4");
    const { token } = await join(stub, { slackUserId: "U1", displayName: "Xavier" });

    // Age the row past its TTL.
    await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("UPDATE invite_link SET expires_at = ?", Date.now() - 1),
    );
    expect(await withRoom(stub, (live) => live.resolveJoinToken(token))).toBeNull();

    // A new mint sweeps the expired row.
    await join(stub, { slackUserId: "U2", displayName: "Yan" });
    const rows = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT token FROM invite_link").toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).not.toBe(token);
  });

  it("propagates a failed mint and records nothing", async () => {
    const stub = room("j5");
    inviteFake.failNext();
    await expect(join(stub, { slackUserId: "U1", displayName: "Xavier" })).rejects.toThrow(
      "Zoom invite-links failed",
    );
    const rows = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM invite_link").toArray(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("CoworkingRoom — announcements", () => {
  it("open posts an open card; close turns it into an ended card that carries the invite", async () => {
    const stub = room("ann1");
    await withRoom(stub, (live) => live.adminAnnounceOpen());
    expect(port.posts).toHaveLength(1);
    const open = port.lastPostJson();
    expect(open).toContain("coworking_join"); // the Join button works with no session behind it
    expect(open).not.toContain("Session started at"); // no session, no start line

    const { closed } = await withRoom(stub, (live) => live.adminAnnounceClose());
    expect(closed).toBe(true);
    expect(port.updates).toHaveLength(1);
    expect(lastUpdatedTs()).toBe(postedTs(0));
    const ended = port.lastUpdateJson();
    expect(ended).toContain("That's a wrap");
    expect(ended).toContain("*Peak:* 0");
    expect(ended).not.toContain("Dropped in"); // no roster
    expect(ended).toContain("coworking_join"); // the standing invite

    // The announcement's ended card is retired by the next session like any other.
    await send(stub, event("meeting.started", "uuid-1"));
    expect(lastUpdatedTs()).toBe(postedTs(0));
    expect(port.lastUpdateJson()).not.toContain("coworking_join");
  });

  it("close is a no-op when nothing was announced", async () => {
    const stub = room("ann2");
    expect(await withRoom(stub, (live) => live.adminAnnounceClose())).toEqual({ closed: false });
    expect(port.updates).toHaveLength(0);
  });

  it("a session start closes a lingering open announcement without the invite", async () => {
    const stub = room("ann3");
    await withRoom(stub, (live) => live.adminAnnounceOpen()); // post #1
    await send(stub, event("meeting.started", "uuid-1")); // post #2

    expect(port.posts).toHaveLength(2);
    expect(lastUpdatedTs()).toBe(postedTs(0));
    const ended = port.lastUpdateJson();
    expect(ended).toContain("That's a wrap");
    expect(ended).not.toContain("coworking_join");
    // The announcement is spent — nothing left for an admin close to edit.
    expect(await withRoom(stub, (live) => live.adminAnnounceClose())).toEqual({ closed: false });
  });
});

describe("CoworkingRoom — vanished room message self-healing", () => {
  it("survives the room message being deleted mid-session", async () => {
    const stub = room("heal3");
    await send(stub, event("meeting.started", "uuid-1")); // posts the open card

    port.vanish(postedTs(0)); // deleted by hand
    // The presence update reports vanished — the join webhook must not throw over it.
    await send(
      stub,
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    // The close update reports vanished too — the session must still end.
    await send(stub, event("meeting.ended", "uuid-1"));

    expect((await sessions(stub))[0]?.status).toBe("ended");
  });

  it("a start still opens the room when the previous ended card was deleted", async () => {
    const stub = room("heal5");
    await send(stub, event("meeting.started", "uuid-1"));
    await send(stub, event("meeting.ended", "uuid-1")); // ended card holds the invite

    port.vanish(postedTs(0));
    // Retiring the vanished card reports vanished — the new session must still open normally.
    await send(stub, event("meeting.started", "uuid-2"));

    expect(port.posts).toHaveLength(2);
    expect((await sessions(stub)).find((r) => r.instance_uuid === "uuid-2")?.slack_message_ts).toBe(
      postedTs(1),
    );
  });

  it("admin close treats a deleted announcement as nothing-to-close", async () => {
    const stub = room("heal4");
    await withRoom(stub, (live) => live.adminAnnounceOpen());

    port.vanish(postedTs(0));
    expect(await withRoom(stub, (live) => live.adminAnnounceClose())).toEqual({ closed: false });
    // The spent pointer is cleared — a repeat close doesn't retry the dead ts.
    expect(await withRoom(stub, (live) => live.adminAnnounceClose())).toEqual({ closed: false });
  });
});

describe("CoworkingRoom — stale-session alarm", () => {
  it("force-ends a still-active session when the alarm fires", async () => {
    const stub = room("a1");
    await send(stub, event("meeting.started", "uuid-1"));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(port.lastUpdateJson()).toContain("session has ended");
    expect((await sessions(stub))[0]?.status).toBe("ended");
  });
});
