import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { respondEphemeral } from "../../slack/response";
import type { SlackBlockActionsPayload } from "../../slack/types";
import { JOIN_ACTION_ID } from "./slack-call";

/**
 * Interactivity handler for the "Join the co-working room" button.
 *
 * The route ACKs Slack within 3s and calls this via `ctx.waitUntil`, so the Zoom registrant
 * work happens after the ACK. We look up the member's email (for registrant correlation),
 * ask the DO to mint a per-user join link, and deliver it privately via `response_url`.
 */

/** Does this interactivity payload represent a click of our Join button? */
export function isJoinClick(payload: SlackBlockActionsPayload): boolean {
  return (
    payload.type === "block_actions" &&
    payload.actions?.some((a) => a.action_id === JOIN_ACTION_ID)
  );
}

export async function handleJoinClick(
  payload: SlackBlockActionsPayload,
  env: Env,
): Promise<void> {
  const slackUserId = payload.user.id;
  const client = createSlackClient(env);

  // Resolve email (scope users:read.email) for clean member↔registrant correlation;
  // fall back to display name if it's missing.
  let email: string | undefined;
  let displayName = "VirtualCoffee member";
  try {
    log.debug("join.profile.fetch", { user: slackUserId });
    const res = await client.users.profile.get({ user: slackUserId });
    email = res.profile?.email || undefined;
    displayName = res.profile?.real_name || res.profile?.display_name || displayName;
  } catch {
    // Keep defaults; the DO falls back to the generic invite link when email is absent.
  }
  log.debug("join.profile.resolved", { user: slackUserId, hasEmail: Boolean(email) });

  log.debug("join.request", { user: slackUserId });
  const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
  const { joinUrl } = await stub.handleJoinRequest({ slackUserId, email, displayName });
  log.info("join.registered", { user: slackUserId, hasEmail: Boolean(email) });

  log.debug("join.respond", { user: slackUserId });
  await respondEphemeral(
    payload.response_url,
    `:coffee: Here's your personal join link for the *${env.ROOM_TITLE}*:\n${joinUrl}`,
  );
}
