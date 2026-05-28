import type { SlackAPIClient } from "slack-web-api-client";
import { describe, expect, it, vi } from "vitest";
import {
  buildRoomOpenBlocks,
  callsEnd,
  callsParticipantsRemove,
  toCallUser,
} from "../src/bots/coworking/slack-call";
import type { Env } from "../src/env";

const env = { ROOM_TITLE: "Co-Working Room" } as Env;

function fakeClient(response: { ok: boolean; error?: string }): SlackAPIClient {
  return { call: vi.fn(async () => response) } as unknown as SlackAPIClient;
}

describe("toCallUser", () => {
  const guest = { zoomUserId: "z1", displayName: "Guest" };

  it("maps a correlated registrant to a slack_id member", () => {
    expect(toCallUser({ slack_user_id: "U123" }, guest)).toEqual({ slack_id: "U123" });
  });

  it("maps an unknown participant to an external guest", () => {
    expect(toCallUser(undefined, guest)).toEqual({ external_id: "z1", display_name: "Guest" });
    expect(toCallUser({ slack_user_id: null }, guest)).toEqual({
      external_id: "z1",
      display_name: "Guest",
    });
  });
});

describe("callsEnd", () => {
  it("treats `inactive_call` as success", async () => {
    await expect(callsEnd(fakeClient({ ok: false, error: "inactive_call" }), "R1")).resolves.toBeUndefined();
  });

  it("throws on a real error", async () => {
    await expect(callsEnd(fakeClient({ ok: false, error: "boom" }), "R1")).rejects.toThrow("boom");
  });
});

describe("callsParticipantsRemove", () => {
  it("treats `user_not_found` as success", async () => {
    await expect(
      callsParticipantsRemove(fakeClient({ ok: false, error: "user_not_found" }), "R1", [
        { slack_id: "U1" },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("buildRoomOpenBlocks", () => {
  it("includes the Join button and (when present) the call widget", () => {
    const withCall = JSON.stringify(buildRoomOpenBlocks(env, "R9"));
    expect(withCall).toContain("coworking_join");
    expect(withCall).toContain('"type":"call"');
    expect(withCall).toContain("R9");

    const withoutCall = JSON.stringify(buildRoomOpenBlocks(env));
    expect(withoutCall).toContain("coworking_join");
    expect(withoutCall).not.toContain('"type":"call"');
  });
});
