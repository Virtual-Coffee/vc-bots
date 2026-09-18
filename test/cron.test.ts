import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_JOBS, runCron } from "../src/cron";
import { installFetchRecorder } from "./helpers/fetch-recorder";

declare global {
  namespace Cloudflare {
    interface Env {
      /** `triggers.crons` from wrangler.jsonc, injected by vitest.config.ts (test-only). */
      TEST_WRANGLER_CRONS: string;
    }
  }
}

// A Monday, 13:00 UTC.
const SCHEDULED_TIME = Date.parse("2026-09-14T13:00:00Z");
const configuredCrons = (): string[] => JSON.parse(env.TEST_WRANGLER_CRONS);

function controller(cron: string): ScheduledController {
  return { cron, scheduledTime: SCHEDULED_TIME, noRetry() {} };
}

afterEach(() => vi.unstubAllGlobals());

describe("CRON_JOBS ↔ wrangler.jsonc", () => {
  it("the CRON_JOBS keys are exactly the configured wrangler crons", () => {
    expect(Object.keys(CRON_JOBS).sort()).toEqual(configuredCrons().sort());
  });

  it("weekday fields are spelled, never numeric (Cloudflare parses them Quartz-style)", () => {
    for (const cron of configuredCrons()) {
      expect(cron.split(" ")[4]).toMatch(/^(\*|[A-Z]{3}(,[A-Z]{3})*)$/);
    }
  });
});

describe("runCron", () => {
  it("a known cron runs its job with the scheduled time", async () => {
    const fetched = installFetchRecorder();
    const job = vi.fn(async () => undefined);

    await runCron(controller("0 12 * * MON"), env, { "0 12 * * MON": job });

    expect(job).toHaveBeenCalledExactlyOnceWith(env, SCHEDULED_TIME);
    expect(fetched.calls).toHaveLength(0);
  });

  it("an unknown cron is a no-op", async () => {
    const fetched = installFetchRecorder();
    const job = vi.fn(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCron(controller("0 0 * * *"), env, { "0 12 * * MON": job });

    expect(job).not.toHaveBeenCalled();
    expect(fetched.calls).toHaveLength(0);
  });

  it("a failing job is swallowed and alerts #bot-log once", async () => {
    const fetched = installFetchRecorder();
    const job = vi.fn(async () => {
      throw new Error("cms down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCron(controller("0 12 * * *"), env, { "0 12 * * *": job })).resolves.toBe(
      undefined,
    );

    const posts = fetched.callsTo("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    const form = fetched.form(posts[0]!);
    expect(form.get("channel")).toBe(env.SLACK_BOTLOG_CHANNEL_ID);
    expect(form.get("text")).toContain("cron.run_failed");
    expect(form.get("text")).toContain("0 12 * * *");
  });

  it("the daily cron reaches the CMS event source", async () => {
    const fetched = installFetchRecorder({
      respond: (call) => {
        if (!call.url.includes(env.CMS_GRAPHQL_URL)) return undefined;
        return call.body.includes("getCalendars")
          ? Response.json({ data: { solspace_calendar: { calendars: [{ handle: "vcEvents" }] } } })
          : Response.json({ data: { solspace_calendar: { events: [] } } });
      },
    });

    await runCron(controller("0 12 * * *"), env);

    expect(fetched.callsTo(env.CMS_GRAPHQL_URL).length).toBeGreaterThan(0);
  });

  it("the Monday 13:00 cron posts the availability trio and seeds its reactions", async () => {
    const fetched = installFetchRecorder({ postTs: ["1.1", "1.2", "1.3"] });

    await runCron(controller("0 13 * * MON"), env);

    const posts = fetched.callsTo("/api/chat.postMessage");
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      expect(fetched.form(post).get("channel")).toBe(env.SLACK_AVAILABILITY_CHANNEL_ID);
    }
    expect(fetched.callsTo("/api/reactions.add")).toHaveLength(10);
  });
});
