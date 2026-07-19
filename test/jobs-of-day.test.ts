import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOBS_OF_DAY_CRON, runJobsOfTheDay } from "../src/bots/jobs-of-day";

const THREAD_TS = "1784293200.000100";
const EDT_FRIDAY_9AM = Date.parse("2026-07-17T13:00:00Z");
const EDT_SATURDAY_MIDNIGHT = Date.parse("2026-07-18T04:00:00Z");

interface RecordedCall {
  url: string;
  body: string;
}

let recorded: RecordedCall[];
let threadMessages: Array<{ ts: string; reply_count?: number; reactions?: unknown[] }>;
let repliesError: string | undefined;
let postError: string | undefined;
let deleteError: string | undefined;
let jobsPostGate: Promise<void> | undefined;
let repliesGate: Promise<void> | undefined;

beforeEach(() => {
  recorded = [];
  threadMessages = [{ ts: THREAD_TS, reply_count: 0 }];
  repliesError = undefined;
  postError = undefined;
  deleteError = undefined;
  jobsPostGate = undefined;
  repliesGate = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const request = input instanceof Request ? input.clone() : undefined;
      const url = request?.url ?? String(input);
      const body = request
        ? new TextDecoder().decode(await request.arrayBuffer())
        : typeof init?.body === "string"
          ? init.body
          : "";
      recorded.push({ url, body });

      if (url.includes("/api/conversations.replies")) {
        await repliesGate;
        if (repliesError) {
          const error = repliesError;
          repliesError = undefined;
          return Response.json({ ok: false, error });
        }
        return Response.json({ ok: true, messages: threadMessages });
      }
      if (url.includes("/api/chat.postMessage")) {
        const channel = new URLSearchParams(body).get("channel");
        if (channel === env.SLACK_JOBS_CHANNEL_ID) await jobsPostGate;
        if (channel === env.SLACK_JOBS_CHANNEL_ID && postError) {
          const error = postError;
          postError = undefined;
          return Response.json({ ok: false, error });
        }
        return Response.json({ ok: true, ts: THREAD_TS, channel });
      }
      if (url.includes("/api/chat.delete") && deleteError) {
        const error = deleteError;
        deleteError = undefined;
        return Response.json({ ok: false, error });
      }
      return Response.json({ ok: true, ts: THREAD_TS });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function jobs(name: string) {
  return env.JOBS_OF_THE_DAY.getByName(name);
}

function callsTo(fragment: string): RecordedCall[] {
  return recorded.filter((call) => call.url.includes(fragment));
}

function jobPosts(): URLSearchParams[] {
  return callsTo("/api/chat.postMessage")
    .map((call) => new URLSearchParams(call.body))
    .filter((body) => body.get("channel") === env.SLACK_JOBS_CHANNEL_ID);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("JobsOfTheDay — posting schedule", () => {
  it("posts once at 9am Eastern during daylight time", async () => {
    const stub = jobs("edt-post");
    const first = await stub.tick(EDT_FRIDAY_9AM);
    const duplicate = await stub.tick(EDT_FRIDAY_9AM);

    expect(first).toEqual({ outcome: "posted", localDate: "2026-07-17", ts: THREAD_TS });
    expect(duplicate).toEqual({ outcome: "skipped", reason: "already-posted" });
    expect(jobPosts()).toHaveLength(1);
    expect(jobPosts()[0]?.get("text")).toBe(
      ":briefcase: *Jobs of the Day — Friday, July 17*\n\n" +
        "Share a job application or LinkedIn post about an opening in this thread.",
    );
  });

  it("posts at 9am Eastern during standard time", async () => {
    const result = await jobs("est-post").tick(Date.parse("2026-01-12T14:00:00Z"));
    expect(result.outcome).toBe("posted");
    expect(jobPosts()).toHaveLength(1);
  });

  it("skips weekends and non-9am initial ticks", async () => {
    const weekend = await jobs("weekend").tick(Date.parse("2026-07-18T13:00:00Z"));
    const lateDeploy = await jobs("late-deploy").tick(Date.parse("2026-07-17T19:00:00Z"));

    expect(weekend).toEqual({ outcome: "skipped", reason: "weekend" });
    expect(lateDeploy).toEqual({ outcome: "skipped", reason: "not-due" });
    expect(jobPosts()).toHaveLength(0);
  });

  it("retries a failed post on the next hourly tick, but only alerts once", async () => {
    const stub = jobs("post-retry");
    postError = "service_unavailable";

    expect(await stub.tick(EDT_FRIDAY_9AM)).toEqual({
      outcome: "failed",
      action: "post",
      localDate: "2026-07-17",
    });
    expect(await stub.tick(Date.parse("2026-07-17T14:00:00Z"))).toEqual({
      outcome: "posted",
      localDate: "2026-07-17",
      ts: THREAD_TS,
    });

    expect(jobPosts()).toHaveLength(2);
    const botLogPosts = callsTo("/api/chat.postMessage").filter(
      (call) => new URLSearchParams(call.body).get("channel") === env.SLACK_BOTLOG_CHANNEL_ID,
    );
    expect(botLogPosts).toHaveLength(1);
  });

  it("expires a failed post at the next Eastern date boundary", async () => {
    const stub = jobs("post-expiry");
    postError = "service_unavailable";
    await stub.tick(EDT_FRIDAY_9AM);
    recorded = [];

    expect(await stub.tick(EDT_SATURDAY_MIDNIGHT)).toEqual({
      outcome: "skipped",
      reason: "not-due",
    });
    expect(await stub.tick(Date.parse("2026-07-18T13:00:00Z"))).toEqual({
      outcome: "skipped",
      reason: "weekend",
    });
    expect(jobPosts()).toHaveLength(0);
  });

  it("serializes overlapping 9am ticks so only one starter is posted", async () => {
    const stub = jobs("concurrent-post");
    const gate = deferred();
    jobsPostGate = gate.promise;

    const ticks = Promise.all([stub.tick(EDT_FRIDAY_9AM), stub.tick(EDT_FRIDAY_9AM)]);
    setTimeout(gate.resolve, 10);
    const results = await ticks;

    expect(results).toEqual([
      { outcome: "posted", localDate: "2026-07-17", ts: THREAD_TS },
      { outcome: "skipped", reason: "already-posted" },
    ]);
    expect(jobPosts()).toHaveLength(1);
  });
});

describe("JobsOfTheDay — midnight cleanup", () => {
  it("deletes a Friday starter with no replies at Saturday midnight", async () => {
    const stub = jobs("delete-empty");
    await stub.tick(EDT_FRIDAY_9AM);
    recorded = [];

    expect(await stub.tick(EDT_SATURDAY_MIDNIGHT)).toEqual({
      outcome: "deleted",
      localDate: "2026-07-17",
    });
    expect(callsTo("/api/conversations.replies")).toHaveLength(1);
    expect(callsTo("/api/chat.delete")).toHaveLength(1);
  });

  it("retains the starter when any reply exists", async () => {
    const stub = jobs("retain-reply");
    await stub.tick(EDT_FRIDAY_9AM);
    threadMessages = [
      { ts: THREAD_TS, reply_count: 1 },
      { ts: "1784332800.000200" },
    ];
    recorded = [];

    expect(await stub.tick(EDT_SATURDAY_MIDNIGHT)).toEqual({
      outcome: "retained",
      localDate: "2026-07-17",
    });
    expect(callsTo("/api/chat.delete")).toHaveLength(0);
  });

  it("does not count reactions as comments", async () => {
    const stub = jobs("reaction-only");
    await stub.tick(EDT_FRIDAY_9AM);
    threadMessages = [{ ts: THREAD_TS, reply_count: 0, reactions: [{ name: "eyes" }] }];
    recorded = [];

    expect((await stub.tick(EDT_SATURDAY_MIDNIGHT)).outcome).toBe("deleted");
    expect(callsTo("/api/chat.delete")).toHaveLength(1);
  });

  it("treats a manually removed starter as complete", async () => {
    const stub = jobs("missing-thread");
    await stub.tick(EDT_FRIDAY_9AM);
    repliesError = "thread_not_found";
    recorded = [];

    expect(await stub.tick(EDT_SATURDAY_MIDNIGHT)).toEqual({
      outcome: "missing",
      localDate: "2026-07-17",
    });
    expect(callsTo("/api/chat.delete")).toHaveLength(0);
  });

  it("fails safe on a reply-read error and retries cleanup the next hour", async () => {
    const stub = jobs("cleanup-retry");
    await stub.tick(EDT_FRIDAY_9AM);
    repliesError = "service_unavailable";
    recorded = [];

    expect(await stub.tick(EDT_SATURDAY_MIDNIGHT)).toEqual({
      outcome: "failed",
      action: "cleanup",
      localDate: "2026-07-17",
    });
    expect(callsTo("/api/chat.delete")).toHaveLength(0);

    expect(await stub.tick(Date.parse("2026-07-18T05:00:00Z"))).toEqual({
      outcome: "deleted",
      localDate: "2026-07-17",
    });
    expect(callsTo("/api/chat.delete")).toHaveLength(1);
  });

  it("fails safe on a delete error and retries cleanup the next hour", async () => {
    const stub = jobs("delete-retry");
    await stub.tick(EDT_FRIDAY_9AM);
    deleteError = "service_unavailable";
    recorded = [];

    expect(await stub.tick(EDT_SATURDAY_MIDNIGHT)).toEqual({
      outcome: "failed",
      action: "cleanup",
      localDate: "2026-07-17",
    });
    expect(callsTo("/api/chat.delete")).toHaveLength(1);

    expect(await stub.tick(Date.parse("2026-07-18T05:00:00Z"))).toEqual({
      outcome: "deleted",
      localDate: "2026-07-17",
    });
    expect(callsTo("/api/chat.delete")).toHaveLength(2);
  });

  it("serializes overlapping midnight ticks so cleanup runs only once", async () => {
    const stub = jobs("concurrent-cleanup");
    await stub.tick(EDT_FRIDAY_9AM);
    recorded = [];
    const gate = deferred();
    repliesGate = gate.promise;

    const ticks = Promise.all([
      stub.tick(EDT_SATURDAY_MIDNIGHT),
      stub.tick(EDT_SATURDAY_MIDNIGHT),
    ]);
    setTimeout(gate.resolve, 10);
    const results = await ticks;

    expect(results).toEqual([
      { outcome: "deleted", localDate: "2026-07-17" },
      { outcome: "skipped", reason: "not-due" },
    ]);
    expect(callsTo("/api/conversations.replies")).toHaveLength(1);
    expect(callsTo("/api/chat.delete")).toHaveLength(1);
  });
});

describe("runJobsOfTheDay", () => {
  it("dispatches only the hourly jobs cron", async () => {
    const singleton = env.JOBS_OF_THE_DAY.getByName("jobs-of-day");
    await runInDurableObject(singleton, (_instance, state) => state.storage.deleteAll());

    await runJobsOfTheDay(
      { cron: "0 12 * * *", scheduledTime: EDT_FRIDAY_9AM } as ScheduledController,
      env,
    );
    expect(jobPosts()).toHaveLength(0);

    await runJobsOfTheDay(
      { cron: JOBS_OF_DAY_CRON, scheduledTime: EDT_FRIDAY_9AM } as ScheduledController,
      env,
    );
    expect(jobPosts()).toHaveLength(1);
  });
});
