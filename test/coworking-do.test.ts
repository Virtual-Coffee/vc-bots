import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoomMeetingEventType } from "../src/zoom/types";

const STARTED_TS = "1700000000.000100";

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

    if (url.includes("zoom.us/oauth/token")) {
      return Response.json({ access_token: "zoom-token", token_type: "bearer", expires_in: 3600 });
    }
    if (url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({ attendees: [{ name: "Member", join_url: "https://zoom.us/w/personal-1" }] });
    }
    return Response.json({ ok: true, ts: STARTED_TS, channel: "C0B6C3BFEDD" });
  });
  vi.stubGlobal("fetch", spy);
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
) {
  return {
    event: type,
    event_ts: tsMs,
    payload: { object: { id: "4669259563", uuid, ...(participant ? { participant } : {}) } },
  } as const;
}

function room(name: string) {
  return env.COWORKING_ROOM.getByName(name);
}
function callsTo(fragment: string): RecordedCall[] {
  return recorded.filter((r) => r.url.includes(fragment));
}
/** The `blocks` payload (JSON string) of the most recent call to a Slack endpoint. */
function lastBlocks(fragment: string): string {
  const call = callsTo(fragment).at(-1);
  return call ? (new URLSearchParams(call.body).get("blocks") ?? "") : "";
}
async function sessions(stub: ReturnType<typeof room>) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql.exec("SELECT * FROM session").toArray(),
  );
}
async function participants(stub: ReturnType<typeof room>) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql.exec("SELECT * FROM participant").toArray(),
  );
}

// --- tests ---

describe("CoworkingRoom — room message lifecycle", () => {
  it("meeting.started posts an open presence message", async () => {
    const stub = room("m1");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
    const open = lastBlocks("/api/chat.postMessage");
    expect(open).toContain("coworking_join"); // modal-trigger Join button

    const rows = await sessions(stub);
    expect(rows[0]?.status).toBe("active");
  });

  it("is idempotent for duplicate meeting.started", async () => {
    const stub = room("m2");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
  });

  it("edits the standing invite in place into the active room (invite → active)", async () => {
    const stub = room("life1");
    await stub.adminPostInvite(); // posts the idle invite, remembers its ts
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);

    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    // No second post — the invite message itself is updated into the open-room view.
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
    const update = callsTo("/api/chat.update").at(-1)!;
    expect(new URLSearchParams(update.body).get("ts")).toBe(STARTED_TS);
    expect(new URLSearchParams(update.body).get("blocks") ?? "").toContain("coworking_join");
    // The open room carries the session start time, from the meeting.started event ts.
    expect(new URLSearchParams(update.body).get("blocks") ?? "").toContain(
      "Session started at <!date^1700000000^{time}|",
    );

    // The session reuses the invite's ts as its tracked message.
    expect((await sessions(stub))[0]?.slack_message_ts).toBe(STARTED_TS);
  });

  it("keeps the room-message pointer after a session starts (reused, not consumed)", async () => {
    const stub = room("ptr1");
    await stub.adminPostInvite();
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    // The pointer still points at the (now active) message so later transitions reuse it —
    // it is no longer deleted on consume, which is what caused the duplicate-post regression.
    const pointer = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<string>("idle_invite_ts"),
    );
    expect(pointer).toBe(STARTED_TS);
  });

  it("a start with a new uuid force-closes a stale active session instead of wedging the room", async () => {
    const stub = room("dbl1");
    await stub.adminPostInvite(); // invite (post #1)
    await stub.handleZoomEvent(event("meeting.started", "uuid-1")); // edits invite → active
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    // uuid-1's meeting.ended was never received; a new instance starts. One meeting ID can only
    // have one live instance, so uuid-1 is necessarily dead — close it and open uuid-2 now
    // rather than dropping the start and waiting for the 18h stale-session alarm.
    await stub.handleZoomEvent(event("meeting.started", "uuid-2"));

    const rows = await sessions(stub);
    expect(rows.find((r) => r.instance_uuid === "uuid-1")?.status).toBe("ended");
    expect(rows.find((r) => r.instance_uuid === "uuid-2")?.status).toBe("active");

    // The stale session got its ended summary, and the fresh invite from closeSession (post #2)
    // was edited into the new open room.
    const endedSummary = callsTo("/api/chat.update").some((c) =>
      (new URLSearchParams(c.body).get("blocks") ?? "").includes("session has ended"),
    );
    expect(endedSummary).toBe(true);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(2);
    expect(lastBlocks("/api/chat.update")).toContain("coworking_join");

    // The wedge is gone: a join on the new instance lands and shows up in presence.
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-2", { user_id: "p2", user_name: "Bob" }),
    );
    expect(lastBlocks("/api/chat.update")).toContain("Bob");
  });

  it("recovers after a missed meeting.ended: alarm closes, next start reuses the fresh invite", async () => {
    const stub = room("miss1");
    await stub.adminPostInvite(); // invite (post #1)
    await stub.handleZoomEvent(event("meeting.started", "uuid-1")); // edits invite → active
    // meeting.ended never arrives → the stale-session alarm force-closes it and posts a fresh
    // invite (post #2), advancing the pointer.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(2);

    // The next session reuses that fresh invite in place — no orphaned duplicate.
    await stub.handleZoomEvent(event("meeting.started", "uuid-2"));
    expect(callsTo("/api/chat.postMessage")).toHaveLength(2);
    expect(new URLSearchParams(callsTo("/api/chat.update").at(-1)!.body).get("ts")).toBe(STARTED_TS);
  });

  it("re-running the admin invite edits the standing message instead of posting a duplicate", async () => {
    const stub = room("reinv1");
    await stub.adminPostInvite(); // post #1
    await stub.adminPostInvite(); // reuse in place → chat.update, no new post

    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
    expect(callsTo("/api/chat.update")).toHaveLength(1);
    expect(lastBlocks("/api/chat.update")).toContain("coworking_join");
  });

  it("posts the ended summary with session length, peak attendance, and a deduped roster", async () => {
    const stub = room("stats1");
    await stub.handleJoinRequest({ slackUserId: "U777", displayName: "Ada" }); // member link

    const t0 = 1_700_000_000_000;
    await stub.handleZoomEvent(eventAt("meeting.started", "uuid-1", t0));
    // Ada (member) and Bob (guest) overlap → peak 2.
    await stub.handleZoomEvent(
      eventAt("meeting.participant_joined", "uuid-1", t0 + 60_000, { user_id: "p1", user_name: "Ada" }),
    );
    await stub.handleZoomEvent(
      eventAt("meeting.participant_joined", "uuid-1", t0 + 120_000, { user_id: "p2", user_name: "Bob" }),
    );
    await stub.handleZoomEvent(
      eventAt("meeting.participant_left", "uuid-1", t0 + 180_000, { user_id: "p1", user_name: "Ada" }),
    );
    // Ends 90 minutes after it started.
    await stub.handleZoomEvent(eventAt("meeting.ended", "uuid-1", t0 + 90 * 60_000));

    // The ended summary is the close update (the post-end invite is a postMessage, not an update).
    const ended = lastBlocks("/api/chat.update");
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

  it("meeting.ended closes the message, posts a fresh invite, and clears participants", async () => {
    const stub = room("m3");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1")); // open message
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    await stub.handleZoomEvent(event("meeting.ended", "uuid-1"));

    // The last chat.update is the "session has ended" close.
    expect(lastBlocks("/api/chat.update")).toContain("session has ended");
    // The open message (started) + the standing invite (ended) = two postMessage calls.
    const posts = callsTo("/api/chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(new URLSearchParams(posts.at(-1)!.body).get("blocks") ?? "").toContain("coworking_join");

    const rows = await sessions(stub);
    expect(rows[0]?.status).toBe("ended");
    expect(await participants(stub)).toHaveLength(0);
  });
});

describe("CoworkingRoom — participant correlation & presence", () => {
  it("shows an un-registered participant as an external guest", async () => {
    const stub = room("c1");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Guest" }),
    );

    // The presence message lists the guest by display name (no mention).
    const presence = lastBlocks("/api/chat.update");
    expect(presence).toContain("Guest");
    expect(presence).not.toContain('"user_id"'); // no mention element — guests are plain text

    const parts = await participants(stub);
    expect(parts[0]?.slack_user_id).toBeNull();
    expect(parts[0]?.external_id).toBe("p1");
  });

  it("maps a member to their slack_id by name and @-mentions them", async () => {
    const stub = room("c2");
    // Member clicks Join first → slack_user_id ↔ display_name recorded.
    const { token } = await stub.handleJoinRequest({
      slackUserId: "U777",
      displayName: "Ada",
    });
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    // No registrant_id on an invite-link join — correlation matches the baked-in name.
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    expect(lastBlocks("/api/chat.update")).toContain('"user_id":"U777"'); // rich-text mention
    const parts = await participants(stub);
    expect(parts[0]?.slack_user_id).toBe("U777");
    expect(parts[0]?.external_id).toBeNull();
  });

  it("falls back to a plain-named guest when the Zoom name doesn't match any member", async () => {
    const stub = room("c2b");
    await stub.handleJoinRequest({ slackUserId: "U777", displayName: "Ada Lovelace" });

    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    // Signed-in member overrode the pre-filled name → no match → shown as a guest by that name.
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "ada (iPhone)" }),
    );

    const presence = lastBlocks("/api/chat.update");
    expect(presence).toContain("ada (iPhone)");
    expect(presence).not.toContain("U777");
    expect((await participants(stub))[0]?.slack_user_id).toBeNull();
  });

  it("is idempotent for duplicate participant_joined", async () => {
    const stub = room("c3");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    const joined = event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" });
    await stub.handleZoomEvent(joined);
    await stub.handleZoomEvent(joined);

    expect(await participants(stub)).toHaveLength(1);
    // The presence line lists Ada exactly once.
    const presence = lastBlocks("/api/chat.update");
    expect(presence.split("Ada").length - 1).toBe(1);
  });

  it("participant_left drops the person from the presence list", async () => {
    const stub = room("c4");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    await stub.handleZoomEvent(
      event("meeting.participant_left", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    // The row is soft-deleted (retained for end-of-session stats) but marked as left.
    const parts = await participants(stub);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.left_at).not.toBeNull();
    // The latest presence update no longer lists Ada (empty-room nudge instead).
    const presence = lastBlocks("/api/chat.update");
    expect(presence).not.toContain("Ada");
    expect(presence.toLowerCase()).toContain("nobody");
  });

  it("drops a participant_joined with no active session (race-safe)", async () => {
    const stub = room("c5");
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    expect(await participants(stub)).toHaveLength(0);
    expect(callsTo("/api/chat.update")).toHaveLength(0);
  });
});

describe("CoworkingRoom — handleJoinRequest", () => {
  it("mints an invite link, stores the slack_user_id ↔ name mapping, and returns an opaque token", async () => {
    const stub = room("j1");
    const { token } = await stub.handleJoinRequest({
      slackUserId: "U1",
      displayName: "Xavier",
    });

    // The raw join_url never leaves the DO — callers only get the redirect token.
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(callsTo("api.zoom.us/v2/meetings/")).toHaveLength(1);
    const links = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM member_link").toArray(),
    );
    expect(links[0]?.slack_user_id).toBe("U1");
    expect(links[0]?.display_name).toBe("Xavier");
  });

  it("resolveJoinToken round-trips the token to the personal join url", async () => {
    const stub = room("j3");
    const { token } = await stub.handleJoinRequest({ slackUserId: "U1", displayName: "Xavier" });

    expect(await stub.resolveJoinToken(token)).toEqual({ joinUrl: "https://zoom.us/w/personal-1" });
    expect(await stub.resolveJoinToken("0".repeat(32))).toBeNull(); // unknown token
  });

  it("expires tokens and sweeps expired rows on the next mint", async () => {
    const stub = room("j4");
    const { token } = await stub.handleJoinRequest({ slackUserId: "U1", displayName: "Xavier" });

    // Age the row past its TTL.
    await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("UPDATE invite_link SET expires_at = ?", Date.now() - 1),
    );
    expect(await stub.resolveJoinToken(token)).toBeNull();

    // A new mint sweeps the expired row.
    await stub.handleJoinRequest({ slackUserId: "U2", displayName: "Yan" });
    const rows = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT token FROM invite_link").toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).not.toBe(token);
  });

  it("sends only the attendee name to Zoom — no email or registration fields", async () => {
    const stub = room("j2");
    await stub.handleJoinRequest({ slackUserId: "U777", displayName: "Ada Lovelace" });

    const req = callsTo("api.zoom.us/v2/meetings/").at(-1)!;
    expect(req.url).toContain("/invite_links");
    const sent = JSON.parse(req.body);
    expect(sent.attendees).toEqual([{ name: "Ada Lovelace" }]);
    expect(sent.email).toBeUndefined();
    expect(sent.first_name).toBeUndefined();
    expect(typeof sent.ttl).toBe("number");
  });
});

describe("CoworkingRoom — admin announce-only", () => {
  it("open posts a plain announcement and close updates it", async () => {
    const stub = room("ann1");
    await stub.adminAnnounceOpen();
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);

    const { closed } = await stub.adminAnnounceClose();
    expect(closed).toBe(true);
    expect(callsTo("/api/chat.update")).toHaveLength(1);
  });

  it("close is a no-op when nothing was announced", async () => {
    const stub = room("ann2");
    expect(await stub.adminAnnounceClose()).toEqual({ closed: false });
    expect(callsTo("/api/chat.update")).toHaveLength(0);
  });

  it("invite posts a 'start a session' message with the modal-trigger Join button", async () => {
    const stub = room("ann3");
    await stub.adminPostInvite();

    const posts = callsTo("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    const blocks = new URLSearchParams(posts[0]!.body).get("blocks") ?? "";
    expect(blocks).toContain("coworking_join");
  });
});

describe("CoworkingRoom — stale room-message pointer self-healing", () => {
  const FRESH_TS = "1700000099.000200";

  /** Re-stub fetch so chat.update reports the target message vanished (deleted by hand). */
  function stubVanishedMessage() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { body?: unknown }) => {
        let url: string;
        let body = "";
        if (input instanceof Request) {
          url = input.url;
          body = new TextDecoder().decode(await input.clone().arrayBuffer());
        } else {
          url = String(input);
          body = typeof init?.body === "string" ? init.body : "";
        }
        recorded.push({ url, body });
        if (url.includes("/api/chat.update")) {
          return Response.json({ ok: false, error: "message_not_found" });
        }
        return Response.json({ ok: true, ts: FRESH_TS, channel: "C0B6C3BFEDD" });
      }),
    );
  }

  it("re-running the admin invite re-posts when the standing message was deleted", async () => {
    const stub = room("heal1");
    await stub.adminPostInvite(); // post #1, stores the pointer

    stubVanishedMessage();
    await stub.adminPostInvite(); // update 404s → fresh post, pointer advances — no throw

    expect(callsTo("/api/chat.postMessage")).toHaveLength(2);
    const pointer = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<string>("idle_invite_ts"),
    );
    expect(pointer).toBe(FRESH_TS);
  });

  it("meeting.started posts a fresh open message when the standing invite was deleted", async () => {
    const stub = room("heal2");
    await stub.adminPostInvite();

    stubVanishedMessage();
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    expect(callsTo("/api/chat.postMessage")).toHaveLength(2);
    expect((await sessions(stub))[0]?.slack_message_ts).toBe(FRESH_TS);
  });

  it("survives the room message being deleted mid-session", async () => {
    const stub = room("heal3");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1")); // posts the open message

    stubVanishedMessage();
    // The presence update 404s — the join webhook must not throw over it.
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    // The close update 404s too — the session still ends and the fresh invite still posts.
    await stub.handleZoomEvent(event("meeting.ended", "uuid-1"));

    expect((await sessions(stub))[0]?.status).toBe("ended");
    expect(callsTo("/api/chat.postMessage")).toHaveLength(2); // open message + fresh invite
  });

  it("admin close treats a deleted announcement as nothing-to-close", async () => {
    const stub = room("heal4");
    await stub.adminAnnounceOpen();

    stubVanishedMessage();
    expect(await stub.adminAnnounceClose()).toEqual({ closed: false });
    // The spent pointer is cleared — a repeat close doesn't retry the dead ts.
    expect(await stub.adminAnnounceClose()).toEqual({ closed: false });
  });
});

describe("CoworkingRoom — stale-session alarm", () => {
  it("force-ends a still-active session when the alarm fires", async () => {
    const stub = room("a1");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(lastBlocks("/api/chat.update")).toContain("session has ended");
    expect((await sessions(stub))[0]?.status).toBe("ended");
  });
});
