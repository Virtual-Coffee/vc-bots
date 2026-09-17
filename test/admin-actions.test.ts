import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdminResult, adminReplyText, runAdminAction } from "../src/bots/admin/actions";
import type { GoogleCalendarEvent } from "../src/google/calendar";
import {
  type FetchRecorder,
  installFetchRecorder,
  type RecordedCall,
} from "./helpers/fetch-recorder";

/**
 * Unit coverage for the surface-agnostic admin actions: the workspace-admin gate, each
 * operation's side effects (via the stubbed-fetch harness), the failed path, and the reply
 * text per result. The slash / panel suites only cover their own parsing and reply shapes.
 */

let rec: FetchRecorder;
let isAdmin: boolean;
let googleEvents: GoogleCalendarEvent[];
let postMessageOk: boolean;

beforeEach(() => {
  isAdmin = true;
  googleEvents = [];
  postMessageOk = true;
  rec = installFetchRecorder({
    googleEvents: () => googleEvents,
    respond(call) {
      if (call.url.includes("/api/users.info")) {
        return Response.json({ ok: true, user: { is_admin: isAdmin, is_owner: false } });
      }
      if (!postMessageOk && call.url.includes("/api/chat.postMessage")) {
        return Response.json({ ok: false, error: "channel_not_found" });
      }
      return undefined;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function callsTo(fragment: string): RecordedCall[] {
  return rec.callsTo(fragment);
}
function googleEvt(startMs: number): GoogleCalendarEvent {
  const iso = new Date(startMs).toISOString();
  return { id: "1", summary: "Soon", start: { dateTime: iso }, end: { dateTime: iso } };
}

describe("runAdminAction — gate", () => {
  it("a non-admin is denied and nothing fires", async () => {
    isAdmin = false;
    const result = await runAdminAction(env, "U1", { kind: "home", userId: "U1" });
    expect(result).toEqual({ kind: "denied" });
    expect(callsTo("/api/views.publish")).toHaveLength(0);
  });

  it("an allowlisted id bypasses users.info", async () => {
    isAdmin = false;
    const result = await runAdminAction(env, "U031H1A1BGR", {
      kind: "home",
      userId: "U031H1A1BGR",
    });
    expect(result).toEqual({ kind: "home" });
    expect(callsTo("/api/users.info")).toHaveLength(0);
    expect(callsTo("/api/views.publish")).toHaveLength(1);
  });
});

describe("runAdminAction — reminder", () => {
  it("daily schedules a starting-soon pair and reports it", async () => {
    googleEvents = [googleEvt(Date.now() + 6 * 3_600_000)];
    const result = await runAdminAction(env, "U1", {
      kind: "reminder",
      name: "daily",
      nowMs: Date.now(),
    });
    expect(callsTo("/api/chat.scheduleMessage")).toHaveLength(2); // public + admin mirror
    expect(result.kind).toBe("reminder");
    if (result.kind !== "reminder") return;
    expect(result.name).toBe("daily");
    expect(result.result.scheduled).toBe(1);
  });

  it("weekly posts the summary and reports no schedule", async () => {
    googleEvents = [googleEvt(Date.now() + 3_600_000)];
    const result = await runAdminAction(env, "U1", {
      kind: "reminder",
      name: "weekly",
      nowMs: Date.now(),
      source: "google",
    });
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
    expect(result).toMatchObject({
      kind: "reminder",
      name: "weekly",
      result: { posted: true, count: 1, source: "google" },
    });
  });
});

describe("runAdminAction — welcome / home", () => {
  it("welcome DMs the target with the welcome blocks", async () => {
    const result = await runAdminAction(env, "U1", { kind: "welcome", target: "U2" });
    expect(result).toEqual({ kind: "welcome", target: "U2" });
    const post = callsTo("/api/chat.postMessage");
    expect(post).toHaveLength(1);
    const form = rec.form(post[0]!);
    expect(form.get("channel")).toBe("U2");
    // The same DM the `team_join` sender posts — the admin run is the real thing, not a preview.
    expect(form.get("text")).toBe("👋 Welcome to Virtual Coffee!");
    expect(form.get("link_names")).toBe("true");
    expect(form.get("unfurl_links")).toBe("false");
    expect(form.get("unfurl_media")).toBe("false");
    expect(form.get("blocks")).toBeTruthy();
  });

  it("home publishes the App Home view for the user", async () => {
    const result = await runAdminAction(env, "U1", { kind: "home", userId: "U1" });
    expect(result).toEqual({ kind: "home" });
    const publish = callsTo("/api/views.publish");
    expect(publish).toHaveLength(1);
    expect(rec.form(publish[0]!).get("user_id")).toBe("U1");
  });
});

describe("runAdminAction — coworking", () => {
  // One fixed DO instance (env.ZOOM_MEETING_ID) whose storage carries between tests; reset it so
  // each case starts from a known-empty room.
  beforeEach(async () => {
    const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
    await runInDurableObject(stub, (_i, state) => state.storage.deleteAll());
  });

  it("open posts an announcement; close then updates it", async () => {
    const open = await runAdminAction(env, "U1", { kind: "coworking", op: "open" });
    expect(open).toEqual({ kind: "coworking", op: "open" });
    expect(callsTo("/api/chat.postMessage").length).toBeGreaterThanOrEqual(1);

    rec.calls.length = 0;
    const close = await runAdminAction(env, "U1", { kind: "coworking", op: "close" });
    expect(close).toEqual({ kind: "coworking", op: "close", closed: true });
    expect(callsTo("/api/chat.update")).toHaveLength(1);
  });

  it("close with nothing open reports closed: false", async () => {
    const close = await runAdminAction(env, "U1", { kind: "coworking", op: "close" });
    expect(close).toEqual({ kind: "coworking", op: "close", closed: false });
    expect(callsTo("/api/chat.update")).toHaveLength(0);
  });
});

describe("runAdminAction — watch", () => {
  // The actions address the fixed "default" CalendarSync instance; clear its rows (and the
  // renewal alarm ensureWatch arms) so each case starts with no channel. Not `deleteAll` — that
  // drops the tables too, and the instance only migrates in its constructor.
  beforeEach(async () => {
    const stub = env.CALENDAR_SYNC.getByName("default");
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("DELETE FROM channel; DELETE FROM event_snapshot;");
    });
  });

  it("status with no channel is not active", async () => {
    const result = await runAdminAction(env, "U1", { kind: "watch", op: "status" });
    expect(result).toEqual({
      kind: "watch",
      op: "status",
      status: { active: false, channelId: null, expiresAt: null },
    });
  });

  it("start registers a channel (Google watch call) and reports it active", async () => {
    const result = await runAdminAction(env, "U1", { kind: "watch", op: "start" });
    expect(callsTo("/events/watch")).toHaveLength(1);
    expect(result.kind).toBe("watch");
    if (result.kind !== "watch" || result.op !== "start") return;
    expect(result.status.active).toBe(true);
    expect(result.status.channelId).toBeTruthy();
    expect(result.status.expiresAt).toBeGreaterThan(Date.now());

    const status = await runAdminAction(env, "U1", { kind: "watch", op: "status" });
    expect(status).toEqual({ kind: "watch", op: "status", status: result.status });
  });

  it("stop tears the channel down; a second stop has nothing to do", async () => {
    await runAdminAction(env, "U1", { kind: "watch", op: "start" });
    const stopped = await runAdminAction(env, "U1", { kind: "watch", op: "stop" });
    expect(stopped).toEqual({ kind: "watch", op: "stop", stopped: true });
    expect(callsTo("/channels/stop")).toHaveLength(1);

    const again = await runAdminAction(env, "U1", { kind: "watch", op: "stop" });
    expect(again).toEqual({ kind: "watch", op: "stop", stopped: false });
  });
});

describe("runAdminAction — failures", () => {
  it("a rejected operation comes back as failed instead of throwing", async () => {
    postMessageOk = false;
    const result = await runAdminAction(env, "U1", { kind: "welcome", target: "U2" });
    expect(result).toEqual({ kind: "failed" });
  });
});

describe("adminReplyText", () => {
  const cases: [string, AdminResult, string][] = [
    ["denied", { kind: "denied" }, ":no_entry: This command is for workspace admins only."],
    ["failed", { kind: "failed" }, ":warning: That failed — check the worker logs for details."],
    [
      "reminder posted, with schedule",
      {
        kind: "reminder",
        name: "daily",
        result: { posted: true, count: 2, scheduled: 1, source: "google" },
      },
      ":white_check_mark: Posted the *daily* reminder (2 events, source: *google*). Scheduled 1 starting-soon message.",
    ],
    [
      "reminder posted, no schedule",
      { kind: "reminder", name: "weekly", result: { posted: true, count: 1, source: "google" } },
      ":white_check_mark: Posted the *weekly* reminder (1 event, source: *google*).",
    ],
    [
      "reminder skipped on Monday",
      {
        kind: "reminder",
        name: "daily",
        result: { posted: false, count: 0, scheduled: 0, reason: "monday", source: "google" },
      },
      ":information_source: Skipped the *daily* summary — the weekly reminder covers Mondays (source: *google*). Scheduled 0 starting-soon messages.",
    ],
    [
      "reminder with no events",
      {
        kind: "reminder",
        name: "weekly",
        result: { posted: false, count: 0, reason: "no-events", source: "google" },
      },
      ":information_source: No upcoming events for the *weekly* window — nothing posted (source: *google*).",
    ],
    [
      "welcome",
      { kind: "welcome", target: "U2" },
      ":white_check_mark: Sent the welcome message to <@U2>.",
    ],
    ["home", { kind: "home" }, ":white_check_mark: Published your App Home."],
    [
      "coworking open",
      { kind: "coworking", op: "open" },
      ":white_check_mark: Posted the co-working room-open announcement.",
    ],
    [
      "coworking closed",
      { kind: "coworking", op: "close", closed: true },
      ":white_check_mark: Closed the co-working announcement.",
    ],
    [
      "coworking nothing to close",
      { kind: "coworking", op: "close", closed: false },
      ":information_source: No open announcement to close.",
    ],
    [
      "watch inactive",
      { kind: "watch", op: "status", status: { active: false, channelId: null, expiresAt: null } },
      ":mute: Calendar watch is *not active*.",
    ],
    [
      "watch active",
      {
        kind: "watch",
        op: "start",
        status: { active: true, channelId: "chan-1", expiresAt: 1_700_000_000_000 },
      },
      ":satellite_antenna: Calendar watch is *active*. Channel: `chan-1`. Expires <!date^1700000000^{date_short_pretty} {time}|2023-11-14 22:13 UTC>.",
    ],
    [
      "watch stopped",
      { kind: "watch", op: "stop", stopped: true },
      ":octagonal_sign: Calendar watch stopped.",
    ],
    [
      "watch nothing to stop",
      { kind: "watch", op: "stop", stopped: false },
      ":information_source: No active calendar watch to stop.",
    ],
  ];

  it.each(cases)("%s", (_name, result, text) => {
    expect(adminReplyText(result)).toBe(text);
  });
});
