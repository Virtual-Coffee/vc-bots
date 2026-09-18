import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilitySheet } from "../src/bots/availability/durable-object";
import { ROLES } from "../src/bots/availability/message";
import {
  installFetchRecorder,
  type FetchRecorder,
  type RecordedCall,
} from "./helpers/fetch-recorder";

/**
 * The availability sheet end to end: real DO, `fetch` recorded and stubbed. Message layouts are
 * covered in availability-message.test.ts; this suite asserts posting, seeding, pointer
 * handling, and refresh coalescing — what reaches Slack and in what order.
 */

const INTRO_TS = "1700000000.000100";
const TUE_TS = "1700000001.000100";
const THU_TS = "1700000002.000100";
const BOT = "UBOT";
const NOW = Date.parse("2026-09-14T13:00:00Z"); // a Monday

let fetched: FetchRecorder;
let sheetNo = 0;

beforeEach(() => {
  fetched = installFetchRecorder({ postTs: [INTRO_TS, TUE_TS, THU_TS], botUserId: BOT });
});
afterEach(() => vi.unstubAllGlobals());

/** A fresh DO instance per test so storage never leaks between them. */
function sheet() {
  return env.AVAILABILITY_SHEET.getByName(`sheet-${++sheetNo}`);
}
const callsTo = (fragment: string) => fetched.callsTo(fragment);
const form = (call: RecordedCall) => fetched.form(call);

/** Canned `reactions.get` answers per message ts. */
function reactionsResponder(byTs: Record<string, Array<{ name: string; users: string[] }>>) {
  return (call: RecordedCall) => {
    if (!call.url.includes("/api/reactions.get")) return undefined;
    const ts = form(call).get("timestamp") ?? "";
    return Response.json({ ok: true, message: { reactions: byTs[ts] ?? [] } });
  };
}

describe("post", () => {
  it("posts intro → Tuesday → Thursday to the availability channel and stores the day pointers", async () => {
    const stub = sheet();
    const result = await stub.post(NOW);

    const posts = callsTo("/api/chat.postMessage");
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => form(p).get("channel"))).toEqual(Array(3).fill("C-TEST-AVAIL"));
    expect(form(posts[0]!).get("text")).toContain("<!channel>");
    expect(fetched.lastBlocks("/api/chat.postMessage")).toContain("Thursday · Sep 17");
    expect(result).toEqual({ tuesday: TUE_TS, thursday: THU_TS });
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("day_messages")).toEqual({
        tuesday: TUE_TS,
        thursday: THU_TS,
        postedAtMs: NOW,
      });
    });
  });

  it("seeds the five role reactions on each day message, in role order", async () => {
    await sheet().post(NOW);

    const adds = callsTo("/api/reactions.add").map((c) => [
      form(c).get("timestamp"),
      form(c).get("name"),
    ]);
    const names = ROLES.map((r) => r.reaction);
    expect(adds).toEqual([...names.map((n) => [TUE_TS, n]), ...names.map((n) => [THU_TS, n])]);
  });

  it("tolerates already_reacted while seeding", async () => {
    fetched.respondWith((call) =>
      call.url.includes("/api/reactions.add")
        ? Response.json({ ok: false, error: "already_reacted" })
        : undefined,
    );

    await expect(sheet().post(NOW)).resolves.toBeDefined();
    expect(callsTo("/api/reactions.add")).toHaveLength(10);
  });

  it("posting again repoints: the previous day messages are ignored from then on", async () => {
    const stub = sheet();
    await stub.post(NOW);
    fetched.respondWith(undefined);
    vi.unstubAllGlobals();
    fetched = installFetchRecorder({ postTs: ["2.0", "2.1", "2.2"], botUserId: BOT });

    await stub.post(NOW);

    expect(await stub.refresh(TUE_TS, "U1")).toBe("ignored");
    expect(await stub.refresh("2.1", "U1")).toBe("refreshed");
  });
});

describe("refresh", () => {
  it("ignores a ts that isn't one of this week's day messages", async () => {
    const stub = sheet();
    await stub.post(NOW);

    expect(await stub.refresh(INTRO_TS, "U1")).toBe("ignored");
    expect(await stub.refresh("9.9", "U1")).toBe("ignored");
    expect(callsTo("/api/reactions.get")).toHaveLength(0);
  });

  it("ignores the bot's own seed reactions, caching auth.test", async () => {
    const stub = sheet();
    await stub.post(NOW);

    expect(await stub.refresh(TUE_TS, BOT)).toBe("ignored");
    expect(await stub.refresh(THU_TS, BOT)).toBe("ignored");
    expect(callsTo("/api/auth.test")).toHaveLength(1);
    expect(callsTo("/api/chat.update")).toHaveLength(0);
  });

  it("re-reads the reactions and rewrites the day message with the sign-ups, never the bot", async () => {
    const stub = sheet();
    await stub.post(NOW);
    fetched.respondWith(
      reactionsResponder({
        [TUE_TS]: [
          { name: "computer", users: [BOT, "U1"] },
          { name: "x", users: ["U2"] },
        ],
      }),
    );

    expect(await stub.refresh(TUE_TS, "U1")).toBe("refreshed");

    const get = callsTo("/api/reactions.get");
    expect(get).toHaveLength(1);
    expect(form(get[0]!).get("full")).toBe("true");
    const update = callsTo("/api/chat.update");
    expect(update).toHaveLength(1);
    expect(form(update[0]!).get("ts")).toBe(TUE_TS);
    const blocks = form(update[0]!).get("blocks") ?? "";
    expect(blocks).toContain("Tuesday · Sep 15");
    expect(blocks).toContain(":computer: *Host:* <@U1>");
    expect(blocks).toContain(":x: *Unavailable:* <@U2>");
    expect(blocks).not.toContain(BOT);
  });

  it("coalesces refreshes that arrive while one is in flight into a single trailing render", async () => {
    const stub = sheet();
    await stub.post(NOW);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reactors = ["U1"];
    fetched.respondWith(async (call) => {
      if (!call.url.includes("/api/reactions.get")) return undefined;
      await gate;
      return Response.json({
        ok: true,
        message: { reactions: [{ name: "memo", users: reactors }] },
      });
    });

    await runInDurableObject(stub, async (i) => {
      const instance = i as AvailabilitySheet;
      const a = instance.refresh(TUE_TS, "U1");
      await Promise.resolve();
      reactors = ["U1", "U2"];
      const b = instance.refresh(TUE_TS, "U2");
      reactors = ["U1", "U2", "U3"];
      const c = instance.refresh(TUE_TS, "U3");
      release();
      await expect(Promise.all([a, b, c])).resolves.toEqual([
        "refreshed",
        "refreshed",
        "refreshed",
      ]);
    });

    expect(callsTo("/api/reactions.get")).toHaveLength(2);
    const updates = callsTo("/api/chat.update");
    expect(updates).toHaveLength(2);
    expect(form(updates[1]!).get("blocks")).toContain(":memo: *Notetaker:* <@U1>, <@U2>, <@U3>");
  });

  it("warns and moves on when the day message vanished", async () => {
    const stub = sheet();
    await stub.post(NOW);
    fetched.respondWith((call) =>
      call.url.includes("/api/reactions.get")
        ? Response.json({ ok: false, error: "message_not_found" })
        : undefined,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(stub.refresh(TUE_TS, "U1")).resolves.toBe("refreshed");

    expect(callsTo("/api/chat.update")).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("rethrows any other Slack error", async () => {
    const stub = sheet();
    await stub.post(NOW);
    fetched.respondWith((call) =>
      call.url.includes("/api/reactions.get")
        ? Response.json({ ok: false, error: "ratelimited" })
        : undefined,
    );

    await runInDurableObject(stub, async (i) => {
      const instance = i as AvailabilitySheet;
      await expect(instance.refresh(TUE_TS, "U1")).rejects.toThrow(/ratelimited/);
    });
  });

  it("works on a fresh instance whose storage was pre-seeded (no in-memory state needed)", async () => {
    const stub = sheet();
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("day_messages", {
        tuesday: TUE_TS,
        thursday: THU_TS,
        postedAtMs: NOW,
      });
    });

    expect(await stub.refresh(THU_TS, "U1")).toBe("refreshed");
    expect(form(callsTo("/api/chat.update")[0]!).get("ts")).toBe(THU_TS);
  });
});
