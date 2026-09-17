import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_TO_KIND, runReminders, type sendReminder } from "../src/bots/reminders";
import { installFetchRecorder } from "./helpers/fetch-recorder";

declare global {
  namespace Cloudflare {
    interface Env {
      /** `triggers.crons` from wrangler.jsonc, injected by vitest.config.ts (test-only). */
      TEST_WRANGLER_CRONS: string;
    }
  }
}

const SCHEDULED_TIME = Date.parse("2026-05-25T12:00:00Z");
const configuredCrons = (): string[] => JSON.parse(env.TEST_WRANGLER_CRONS);

function controller(cron: string): ScheduledController {
  return { cron, scheduledTime: SCHEDULED_TIME, noRetry() {} };
}

afterEach(() => vi.unstubAllGlobals());

describe("CRON_TO_KIND ↔ wrangler.jsonc", () => {
  it("every CRON_TO_KIND key is a configured wrangler cron", () => {
    expect(Object.keys(CRON_TO_KIND).sort()).toEqual(configuredCrons().sort());
  });

  it("weekday fields are spelled, never numeric (Cloudflare parses them Quartz-style)", () => {
    for (const cron of configuredCrons()) {
      expect(cron.split(" ")[4]).toMatch(/^(\*|[A-Z]{3}(,[A-Z]{3})*)$/);
    }
  });
});

describe("runReminders", () => {
  it("a known cron runs its reminder with the scheduled time", async () => {
    const fetched = installFetchRecorder();
    const send = vi.fn<typeof sendReminder>(async () => ({
      posted: true,
      count: 0,
      source: "google",
    }));

    await runReminders(controller("0 12 * * MON"), env, {} as ExecutionContext, send);

    expect(send).toHaveBeenCalledExactlyOnceWith("weekly", env, SCHEDULED_TIME);
    expect(fetched.calls).toHaveLength(0);
  });

  it("an unknown cron is a no-op", async () => {
    const fetched = installFetchRecorder();
    const send = vi.fn<typeof sendReminder>();

    await runReminders(controller("0 0 * * *"), env, {} as ExecutionContext, send);

    expect(send).not.toHaveBeenCalled();
    expect(fetched.calls).toHaveLength(0);
  });

  it("a failing reminder is swallowed and alerts #bot-log once", async () => {
    const fetched = installFetchRecorder();
    const send = vi.fn<typeof sendReminder>(async () => {
      throw new Error("cms down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runReminders(controller("0 12 * * *"), env, {} as ExecutionContext, send),
    ).resolves.toBeUndefined();

    const posts = fetched.callsTo("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    const form = fetched.form(posts[0]!);
    expect(form.get("channel")).toBe(env.SLACK_BOTLOG_CHANNEL_ID);
    expect(form.get("text")).toContain("reminder.run_failed");
    expect(form.get("text")).toContain("0 12 * * *");
  });
});
