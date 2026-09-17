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
 * Post a new ephemeral reply to a Slack `response_url` (interactivity + slash-command
 * follow-ups). Pins `response_type: "ephemeral"` and `replace_original: false`, so it is safe
 * against any `response_url` — including a shared channel message's. See ADR 0004.
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
 * Replace the message an interaction came from (`replace_original: true`). Per-user
 * ephemerals only (the admin panel), never a shared channel message's `response_url`. ADR 0004.
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
 * Delete the message an interaction came from. Per-user ephemerals only (the join ephemeral),
 * never a shared channel message's `response_url`. ADR 0004.
 */
export async function deleteOriginal(responseUrl: string): Promise<void> {
  await postToResponseUrl(responseUrl, { delete_original: true }, "deleteOriginal");
}
