import type { AnyMessageBlock, MessageAttachment } from "slack-cloudflare-workers";
import { log } from "../log";

/**
 * POST a payload to a Slack `response_url`. These run inside `ctx.waitUntil` lazy handlers, so
 * a network blip or non-2xx is fire-and-forget — the caller can't recover and we mustn't throw
 * (an unhandled rejection there is invisible). Log it instead.
 */
async function postToResponseUrl(
  responseUrl: string,
  body: Record<string, unknown>,
  action: string,
): Promise<void> {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn("slack.response_url.not_ok", { action, status: res.status });
    }
  } catch (error) {
    log.warn("slack.response_url.error", { action, error: String(error) });
  }
}

/**
 * Post a message to a Slack `response_url` (interactivity + slash-command follow-ups).
 * Defaults to an ephemeral reply visible only to the invoking user.
 *
 * `replace_original: false` matters when the interaction came from a shared channel message
 * (e.g. the room's Join button): without it Slack could replace that message for everyone
 * instead of adding a new ephemeral for the clicker.
 */
export async function respondEphemeral(
  responseUrl: string,
  text: string,
  blocks?: AnyMessageBlock[],
  attachments?: MessageAttachment[],
): Promise<void> {
  await postToResponseUrl(
    responseUrl,
    {
      response_type: "ephemeral",
      replace_original: false,
      text,
      ...(blocks ? { blocks } : {}),
      ...(attachments ? { attachments } : {}),
    },
    "respondEphemeral",
  );
}

/**
 * Replace the message an interaction came from with new content (`replace_original: true`).
 * Only safe for per-user surfaces (the admin panel ephemeral) — on a shared channel message
 * (e.g. the room's Join button) this would rewrite that message for everyone.
 */
export async function replaceEphemeral(
  responseUrl: string,
  text: string,
  blocks?: AnyMessageBlock[],
): Promise<void> {
  await postToResponseUrl(
    responseUrl,
    {
      response_type: "ephemeral",
      replace_original: true,
      text,
      ...(blocks ? { blocks } : {}),
    },
    "replaceEphemeral",
  );
}

/**
 * Delete the message an interaction came from. Only safe for per-user surfaces (the join
 * ephemeral) — on a shared channel message this would delete it for everyone.
 */
export async function deleteOriginal(responseUrl: string): Promise<void> {
  await postToResponseUrl(responseUrl, { delete_original: true }, "deleteOriginal");
}
