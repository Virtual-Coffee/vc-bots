import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_KINDS, sendReminder } from "../src/bots/reminders";

let cmsEvents: Array<{ id: string; title: string; startsAt: string }>;
let postCount: number;

beforeEach(() => {
  cmsEvents = [];
  postCount = 0;
  const spy = vi.fn(async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("virtualcoffee.io/graphql")) {
      return Response.json({ data: { events: cmsEvents } });
    }
    if (url.includes("/api/chat.postMessage")) postCount += 1;
    return Response.json({ ok: true, ts: "1.1", channel: "C" });
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse("2026-05-28T12:00:00Z");

describe("sendReminder", () => {
  it("posts and reports the count when events fall in the window", async () => {
    cmsEvents = [{ id: "1", title: "Lunch", startsAt: "2026-05-28T18:00:00Z" }]; // +6h
    const result = await sendReminder(REMINDER_KINDS.daily, env, NOW);
    expect(result).toEqual({ posted: true, count: 1 });
    expect(postCount).toBe(1);
  });

  it("posts nothing when there are no upcoming events in the window", async () => {
    cmsEvents = [{ id: "1", title: "Next week", startsAt: "2026-06-10T12:00:00Z" }];
    const result = await sendReminder(REMINDER_KINDS.daily, env, NOW);
    expect(result).toEqual({ posted: false, count: 0 });
    expect(postCount).toBe(0);
  });
});
