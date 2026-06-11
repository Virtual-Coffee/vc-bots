import type { AnyMessageBlock, MessageAttachment } from "slack-cloudflare-workers";

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
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: false,
      text,
      ...(blocks ? { blocks } : {}),
      ...(attachments ? { attachments } : {}),
    }),
  });
}

/**
 * Delete the message an interaction came from. Only safe for per-user surfaces (the join
 * ephemeral) — on a shared channel message this would delete it for everyone.
 */
export async function deleteOriginal(responseUrl: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete_original: true }),
  });
}
