import type { Env } from "../env";
import { log } from "../log";
import { createSlackClient } from "./client";

/**
 * Post an error alert to the private `#bot-log` channel (`SLACK_BOTLOG_CHANNEL_ID`). Called
 * explicitly at catch sites with no other surface, not from `log.ts` — see ADR 0006.
 *
 * Three guarantees on the failure path: no-op when unconfigured, self-swallowing, no recursion.
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
