import type { Env } from "../env";
import { log } from "../log";
import { createSlackClient } from "./client";

/**
 * Post an important error alert to the private `#bot-log` channel
 * (`SLACK_BOTLOG_CHANNEL_ID`). Called explicitly at the few catch sites with no other surface
 * — the cron reminder run and the co-working DO/Zoom paths — not wired into `log.ts`.
 *
 * Three guarantees, because this runs on the failure path:
 * - **No-op when unconfigured.** Empty channel id → return immediately (safe before the
 *   channel exists / the bot is invited; keeps tests + dev quiet).
 * - **Self-swallowing.** The post goes through the same Slack client that may be failing, so a
 *   throw/non-2xx is logged locally (`botlog.notify_failed`) and swallowed — never rethrown.
 * - **No recursion.** A failed alert is *not* itself alerted (only `log.warn`ed), so there's no
 *   feedback loop.
 */
export async function notifyBotLog(
  env: Env,
  event: string,
  fields?: Record<string, unknown>,
): Promise<void> {
  if (!env.SLACK_BOTLOG_CHANNEL_ID) return;

  // Render fields as `key=val` lines — same shape as the console logger, so the two read alike.
  const detail = fields
    ? Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => {
          const rendered =
            value === null || typeof value === "object" ? JSON.stringify(value) : String(value);
          return `${key}=${rendered}`;
        })
        .join("\n")
    : "";
  const text = detail ? `:rotating_light: *${event}*\n\`\`\`${detail}\`\`\`` : `:rotating_light: *${event}*`;

  try {
    await createSlackClient(env).chat.postMessage({
      channel: env.SLACK_BOTLOG_CHANNEL_ID,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    // Don't re-notify — a failed alert would just loop. Local log only.
    log.warn("botlog.notify_failed", { event, error: String(error) });
  }
}
