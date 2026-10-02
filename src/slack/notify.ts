import type { Env } from "../env";
import { log, renderFields } from "../log";
import { createSlackClient } from "./client";

/**
 * Post an alert to the private `#bot-log` channel (`SLACK_BOTLOG_CHANNEL_ID`). For alerts that
 * aren't a caught exception (e.g. a rejected calendar entry); catch sites call `reportFailure`.
 * Called explicitly, not from `log.ts` — see ADR 0006.
 *
 * Three guarantees on the failure path: no-op when unconfigured, self-swallowing, no recursion.
 */
export async function notifyBotLog(
  env: Env,
  event: string,
  fields?: Record<string, unknown>,
): Promise<void> {
  if (!env.SLACK_BOTLOG_CHANNEL_ID) return;

  // `key=val` lines — same renderer as the console logger, so the two read alike.
  const detail = fields ? renderFields(fields).join("\n") : "";
  const text = detail
    ? `:rotating_light: *${event}*\n\`\`\`${detail}\`\`\``
    : `:rotating_light: *${event}*`;

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

/**
 * The one call for a catch site with no user surface: `log.error`, then alert `#bot-log` with
 * the same fields plus `error` — see ADR 0006. Inherits `notifyBotLog`'s guarantees.
 */
export async function reportFailure(
  env: Env,
  event: string,
  error: unknown,
  fields?: Record<string, unknown>,
): Promise<void> {
  const f = { ...fields, error: String(error) };
  log.error(event, f);
  await notifyBotLog(env, event, f);
}
