import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleReactCommand,
  parseReactCommand,
  type ReactCommandPayload,
} from "../src/bots/coworking/react-command";
import { createSlackRoomChannelPort } from "../src/bots/coworking/room-message";
import { type FetchRecorder, installFetchRecorder } from "./helpers/fetch-recorder";

/**
 * `/coworking-react`: parsing, the preference round-trip through the real co-working DO, the
 * ephemeral replies, and the Slack adapter's `reactions.add` call. When the DO adds the reaction
 * on a join is covered in coworking-do.test.ts.
 */

const RESPONSE_URL = "https://hooks.slack.com/commands/resp-react";

let rec: FetchRecorder;
/** Slack's answer to `reactions.add`; `undefined` falls through to the recorder's `{ ok: true }`. */
let reactionsAdd: object | undefined;

beforeEach(() => {
  reactionsAdd = undefined;
  rec = installFetchRecorder({
    respond: (call) =>
      call.url.includes("/api/reactions.add") && reactionsAdd
        ? Response.json(reactionsAdd)
        : undefined,
  });
});
afterEach(() => vi.unstubAllGlobals());

function cmd(text: string, user_id = "U1"): ReactCommandPayload {
  return { text, user_id, response_url: RESPONSE_URL };
}

function replies(): string[] {
  return rec.callsTo(RESPONSE_URL).map((c) => {
    const body = JSON.parse(c.body) as { text: string; response_type: string };
    expect(body.response_type).toBe("ephemeral");
    return body.text;
  });
}

const room = () => env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);

describe("parseReactCommand", () => {
  it.each([
    ["", { kind: "show" }],
    ["   ", { kind: "show" }],
    ["off", { kind: "clear" }],
    ["OFF", { kind: "clear" }],
    [":crown:", { kind: "set", emoji: "crown" }],
    ["crown", { kind: "set", emoji: "crown" }],
    [" :Party-Parrot: ", { kind: "set", emoji: "party-parrot" }],
    [":+1:", { kind: "set", emoji: "+1" }],
    [":wave::skin-tone-3:", { kind: "set", emoji: "wave::skin-tone-3" }],
    // With colons it's an emoji that happens to be named "off", not the clear verb.
    [":off:", { kind: "set", emoji: "off" }],
  ])("%j → %j", (text, expected) => {
    expect(parseReactCommand(text)).toEqual(expected);
  });

  it.each(["👑", ":crown: :tada:", "crown!", "<@U123>", ":wave::skin-tone-9:", "a".repeat(101)])(
    "rejects %j",
    (text) => {
      expect(parseReactCommand(text).kind).toBe("invalid");
    },
  );
});

describe("handleReactCommand", () => {
  it("sets the reaction in the co-working DO and confirms it", async () => {
    await handleReactCommand(cmd(":crown:", "U-set"), env);

    expect(await room().getJoinReaction("U-set")).toBe("crown");
    expect(replies()).toEqual([expect.stringContaining(":crown:")]);
  });

  it("shows the current reaction, or that none is set", async () => {
    await handleReactCommand(cmd("", "U-show"), env);
    await room().setJoinReaction("U-show", "tada");
    await handleReactCommand(cmd("", "U-show"), env);

    const [none, current] = replies();
    expect(none).toContain("haven't picked");
    expect(current).toContain(":tada:");
  });

  it("off clears it", async () => {
    await room().setJoinReaction("U-off", "tada");
    await handleReactCommand(cmd("off", "U-off"), env);

    expect(await room().getJoinReaction("U-off")).toBeNull();
    expect(replies()).toEqual([expect.stringContaining("won't react")]);
  });

  it("an invalid name gets an error and leaves the saved reaction alone", async () => {
    await room().setJoinReaction("U-bad", "tada");
    await handleReactCommand(cmd("👑", "U-bad"), env);

    expect(await room().getJoinReaction("U-bad")).toBe("tada");
    expect(replies()).toEqual([expect.stringContaining("isn't an emoji name")]);
  });
});

describe("the Slack adapter's react", () => {
  const port = () => createSlackRoomChannelPort(env);

  it("adds the reaction to the co-working channel message", async () => {
    expect(await port().react("1700000000.000001", "crown")).toBe("ok");

    const [call] = rec.callsTo("/api/reactions.add");
    const form = rec.form(call!);
    expect(form.get("channel")).toBe(env.SLACK_COWORKING_CHANNEL_ID);
    expect(form.get("timestamp")).toBe("1700000000.000001");
    expect(form.get("name")).toBe("crown");
  });

  it.each([
    ["already_reacted", "ok"],
    ["invalid_name", "invalid_name"],
    ["message_not_found", "vanished"],
    ["channel_not_found", "vanished"],
  ] as const)("classifies %s as %j", async (error, expected) => {
    reactionsAdd = { ok: false, error };
    expect(await port().react("1700000000.000001", "crown")).toBe(expected);
  });

  it("throws any other failure for the caller to report", async () => {
    reactionsAdd = { ok: false, error: "missing_scope" };
    await expect(port().react("1700000000.000001", "crown")).rejects.toThrow(/missing_scope/);
  });
});
