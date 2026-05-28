import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoomMeetingEventType } from "../src/zoom/types";

const STARTED_TS = "1700000000.000100";
const CALL_ID = "R0123456789";

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
      return Response.json({ registrant_id: "reg-1", id: "reg-1", join_url: "https://zoom.us/w/personal-1" });
    }
    if (url.includes("/api/calls.add")) {
      return Response.json({ ok: true, call: { id: CALL_ID } });
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
  registrant_id?: string;
  email?: string;
}

function event(type: ZoomMeetingEventType, uuid: string, participant?: ParticipantInput) {
  return {
    event: type,
    event_ts: 1_700_000_000_000,
    payload: { object: { id: "4669259563", uuid, ...(participant ? { participant } : {}) } },
  } as const;
}

function room(name: string) {
  return env.COWORKING_ROOM.getByName(name);
}
function callsTo(fragment: string): RecordedCall[] {
  return recorded.filter((r) => r.url.includes(fragment));
}
function lastUsers(fragment: string): Array<Record<string, string>> {
  const call = callsTo(fragment).at(-1)!;
  return JSON.parse(new URLSearchParams(call.body).get("users") ?? "[]");
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

describe("CoworkingRoom — Slack Call lifecycle", () => {
  it("meeting.started creates a Call and posts a message with the call widget", async () => {
    const stub = room("m1");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    expect(callsTo("/api/calls.add")).toHaveLength(1);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
    const rows = await sessions(stub);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.slack_call_id).toBe(CALL_ID);
  });

  it("is idempotent for duplicate meeting.started", async () => {
    const stub = room("m2");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    expect(callsTo("/api/calls.add")).toHaveLength(1);
  });

  it("meeting.ended ends the Call, updates the message, and clears participants", async () => {
    const stub = room("m3");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    await stub.handleZoomEvent(event("meeting.ended", "uuid-1"));

    expect(callsTo("/api/calls.end")).toHaveLength(1);
    expect(callsTo("/api/chat.update")).toHaveLength(1);
    const rows = await sessions(stub);
    expect(rows[0]?.status).toBe("ended");
    expect(await participants(stub)).toHaveLength(0);
  });
});

describe("CoworkingRoom — participant correlation", () => {
  it("shows an un-registered participant as an external guest", async () => {
    const stub = room("c1");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Guest" }),
    );

    const users = lastUsers("/api/calls.participants.add");
    expect(users[0]?.external_id).toBe("p1");
    expect(users[0]?.display_name).toBe("Guest");
    expect(users[0]?.slack_id).toBeUndefined();

    const parts = await participants(stub);
    expect(parts[0]?.slack_user_id).toBeNull();
    expect(parts[0]?.external_id).toBe("p1");
  });

  it("maps a registered member (by registrant_id) to their slack_id", async () => {
    const stub = room("c2");
    // Member clicks Join first → registrant_id ↔ slack_user_id recorded.
    const { joinUrl } = await stub.handleJoinRequest({
      slackUserId: "U777",
      email: "ada@example.com",
      displayName: "Ada",
    });
    expect(joinUrl).toBe("https://zoom.us/w/personal-1");

    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", {
        user_id: "p1",
        user_name: "Ada",
        registrant_id: "reg-1",
      }),
    );

    const users = lastUsers("/api/calls.participants.add");
    expect(users[0]?.slack_id).toBe("U777");
    expect(users[0]?.external_id).toBeUndefined();
  });

  it("is idempotent for duplicate participant_joined", async () => {
    const stub = room("c3");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    const joined = event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" });
    await stub.handleZoomEvent(joined);
    await stub.handleZoomEvent(joined);

    expect(await participants(stub)).toHaveLength(1);
    expect(callsTo("/api/calls.participants.add")).toHaveLength(1);
  });

  it("participant_left removes the participant from the Call", async () => {
    const stub = room("c4");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    await stub.handleZoomEvent(
      event("meeting.participant_left", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );

    expect(callsTo("/api/calls.participants.remove")).toHaveLength(1);
    expect(lastUsers("/api/calls.participants.remove")[0]?.external_id).toBe("p1");
    expect(await participants(stub)).toHaveLength(0);
  });

  it("drops a participant_joined with no active session (race-safe)", async () => {
    const stub = room("c5");
    await stub.handleZoomEvent(
      event("meeting.participant_joined", "uuid-1", { user_id: "p1", user_name: "Ada" }),
    );
    expect(await participants(stub)).toHaveLength(0);
    expect(callsTo("/api/calls.participants.add")).toHaveLength(0);
  });
});

describe("CoworkingRoom — handleJoinRequest", () => {
  it("registers the member with Zoom and stores the correlation", async () => {
    const stub = room("j1");
    const { joinUrl } = await stub.handleJoinRequest({
      slackUserId: "U1",
      email: "x@example.com",
      displayName: "Xavier",
    });

    expect(joinUrl).toBe("https://zoom.us/w/personal-1");
    expect(callsTo("api.zoom.us/v2/meetings/")).toHaveLength(1);
    const regs = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM registrant").toArray(),
    );
    expect(regs[0]?.slack_user_id).toBe("U1");
  });

  it("falls back to the generic invite when no email is available", async () => {
    const stub = room("j2");
    const { joinUrl } = await stub.handleJoinRequest({ slackUserId: "U1", displayName: "X" });

    expect(joinUrl).toContain("us05web.zoom.us/j/4669259563");
    expect(callsTo("api.zoom.us/v2/meetings/")).toHaveLength(0); // no registrant call
  });
});

describe("CoworkingRoom — admin announce-only", () => {
  it("open posts a plain announcement (no Slack Call) and close updates it", async () => {
    const stub = room("ann1");
    await stub.adminAnnounceOpen();
    expect(callsTo("/api/calls.add")).toHaveLength(0);
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
});

describe("CoworkingRoom — stale-session alarm", () => {
  it("force-ends a still-active session when the alarm fires", async () => {
    const stub = room("a1");
    await stub.handleZoomEvent(event("meeting.started", "uuid-1"));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(callsTo("/api/calls.end")).toHaveLength(1);
    expect((await sessions(stub))[0]?.status).toBe("ended");
  });
});
