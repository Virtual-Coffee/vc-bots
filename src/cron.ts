import { postAvailabilityCheckIn } from "./bots/availability";
import { sendReminder } from "./bots/reminders";
import type { Env } from "./env";
import { log } from "./log";
import { notifyBotLog } from "./slack/notify";

/**
 * The cron schedule. Cloudflare fires `scheduled()` with the literal cron string, so this map
 * is the single owner of every cron expression the Worker responds to.
 *
 * Crons fire in UTC; 12:00 UTC = 8am EDT / 7am EST and 13:00 UTC = 9am EDT / 8am EST
 * (accepted DST drift). All three are live in wrangler.jsonc.
 * ⚠️ Keys must match `triggers.crons` byte-for-byte, weekdays spelled — test/cron.test.ts, ADR 0005.
 */
export const CRON_JOBS: Record<string, (env: Env, nowMs: number) => Promise<unknown>> = {
  "0 12 * * *": (env, now) => sendReminder("daily", env, now),
  "0 12 * * MON": (env, now) => sendReminder("weekly", env, now),
  "0 13 * * MON": (env, now) => postAvailabilityCheckIn(env, now),
};

/** Run the job for `controller.cron`. Failures are logged and alerted, never thrown. */
export async function runCron(
  controller: ScheduledController,
  env: Env,
  jobs: typeof CRON_JOBS = CRON_JOBS,
): Promise<void> {
  const job = jobs[controller.cron];
  if (!job) {
    log.warn("cron.unknown", { cron: controller.cron });
    return;
  }
  try {
    await job(env, controller.scheduledTime);
  } catch (error) {
    // No user surface on the cron path — log, alert #bot-log (ADR 0006), and swallow so a
    // CMS/Slack hiccup doesn't surface as an unhandled rejection in `scheduled()`.
    log.error("cron.run_failed", { cron: controller.cron, error: String(error) });
    await notifyBotLog(env, "cron.run_failed", { cron: controller.cron, error: String(error) });
  }
}
