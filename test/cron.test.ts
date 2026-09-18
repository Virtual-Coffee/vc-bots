import { env, runInDurableObject } from "cloudflare:test";
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

  it("the daily cron reaches the Google source and bootstraps the Calendar watch", async () => {
    const fetched = installFetchRecorder();

    await runCron(controller("0 12 * * *"), env);

    expect(fetched.callsTo("/calendar/v3/calendars/").length).toBeGreaterThan(0);
    expect(fetched.callsTo("/events/watch")).toHaveLength(1);
  });

  it("with the interim cms source, the daily cron never touches Google (no watch bootstrap)", async () => {
    const fetched = installFetchRecorder({
      respond: (call) =>
        call.url === env.CMS_GRAPHQL_URL
          ? Response.json({ data: { solspace_calendar: { calendars: [], events: [] } } })
          : undefined,
    });

    await runCron(controller("0 12 * * *"), { ...env, EVENT_SOURCE: "cms" });

    expect(fetched.callsTo(env.CMS_GRAPHQL_URL).length).toBeGreaterThan(0);
    expect(fetched.callsTo("googleapis.com")).toHaveLength(0);
  });

  it("a failing watch bootstrap alerts #bot-log without masking the reminder", async () => {
    const fetched = installFetchRecorder({
      respond: (call) =>
        call.url.endsWith("/events/watch")
          ? Response.json({ error: "nope" }, { status: 500 })
          : undefined,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    // DO storage outlives a test: drop the channel the previous run registered so this one must watch.
    await runInDurableObject(env.CALENDAR_SYNC.getByName("default"), async (_i, state) => {
      state.storage.sql.exec("DELETE FROM channel");
    });

    await runCron(controller("0 12 * * *"), env);

    const alerts = fetched
      .callsTo("/api/chat.postMessage")
      .map((c) => fetched.form(c))
      .filter((f) => f.get("channel") === env.SLACK_BOTLOG_CHANNEL_ID);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.get("text")).toContain("calendar_sync.bootstrap_failed");
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
