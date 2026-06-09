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

    // The session reuses the invite's ts as its tracked message.
    expect((await sessions(stub))[0]?.slack_message_ts).toBe(STARTED_TS);
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
    expect(ended).toContain("Peak 2"); // peak concurrent attendance
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
    expect(presence).not.toContain("<@");

    const parts = await participants(stub);
    expect(parts[0]?.slack_user_id).toBeNull();
    expect(parts[0]?.external_id).toBe("p1");
  });

  it("maps a member to their slack_id by name and @-mentions them", async () => {
    const stub = room("c2");
    // Member clicks Join first → slack_user_id ↔ display_name recorded.
    const { joinUrl } = await stub.handleJoinRequest({
      slackUserId: "U777",
      displayName: "Ada",
    });
    expect(joinUrl).toBe("https://zoom.us/w/personal-1");

    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    // No registrant_id on an invite-link join — correlation matches the baked-in name.
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    expect(lastBlocks("/api/chat.update")).toContain("<@U777>");
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
    expect(presence).not.toContain("<@U777>");
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
  it("mints an invite link and stores the slack_user_id ↔ name mapping", async () => {
    const stub = room("j1");
    const { joinUrl } = await stub.handleJoinRequest({
      slackUserId: "U1",
      displayName: "Xavier",
    });

    expect(joinUrl).toBe("https://zoom.us/w/personal-1");
    expect(callsTo("api.zoom.us/v2/meetings/")).toHaveLength(1);
    const links = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM member_link").toArray(),
    );
    expect(links[0]?.slack_user_id).toBe("U1");
    expect(links[0]?.display_name).toBe("Xavier");
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

describe("CoworkingRoom — stale-session alarm", () => {
  it("force-ends a still-active session when the alarm fires", async () => {
    const stub = room("a1");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(lastBlocks("/api/chat.update")).toContain("session has ended");
    expect((await sessions(stub))[0]?.status).toBe("ended");
  });
});
