import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { deleteOriginal, respondEphemeral } from "../../slack/response";
import type { SlackBlockActionsPayload } from "../../slack/types";
import {
  CANCEL_ACTION_ID,
  JOIN_ACTION_ID,
  JOIN_REDIRECT_ACTION_ID,
  buildJoinEphemeralAttachments,
  joinEphemeralText,
  joinErrorText,
} from "./slack-call";

/**
 * Interactivity handlers for the room "Join" button and the per-user join ephemeral.
 *
 * The route ACKs Slack within 3s and calls these via `ctx.waitUntil`. A channel button's url is
 * identical for every viewer, so it can't carry a per-user link; instead the click mints the
 * member's invite link and posts an ephemeral (a per-user surface) via the click's `response_url`:
 * a Code-of-Conduct note plus ☕ Join / Cancel buttons. Clicking either button deletes the
 * ephemeral (☕ Join also opens Zoom via its `url`), so the surface closes itself — the
 * confirm-dialog feel a modal can't offer (Slack has no API to close a modal from a button click).
 *
 * The ☕ Join url is the Worker's `/join/<token>` redirect, not the raw Zoom link, so Slack's
 * hover tooltip never exposes the token-bearing personal join url.
 */

/** Does this interactivity payload represent a click of the room "Join" button? */
export function isJoinClick(payload: SlackBlockActionsPayload): boolean {
  return (
    payload.type === "block_actions" &&
    Boolean(payload.actions?.some((a) => a.action_id === JOIN_ACTION_ID))
  );
}

/** A click on either join-ephemeral button (☕ Join or Cancel) — both dismiss the ephemeral. */
export function isJoinDismissClick(payload: SlackBlockActionsPayload): boolean {
  return (
    payload.type === "block_actions" &&
    Boolean(
      payload.actions?.some(
        (a) => a.action_id === JOIN_REDIRECT_ACTION_ID || a.action_id === CANCEL_ACTION_ID,
      ),
    )
  );
}

/**
 * Delete the join ephemeral after either of its buttons is clicked. For ☕ Join the browser is
 * already opening the url client-side; this just makes the message vanish behind it.
 */
export async function handleJoinDismiss(
  payload: SlackBlockActionsPayload,
  _env: Env,
): Promise<void> {
  const action = payload.actions?.[0]?.action_id ?? "unknown";
  log.info("join.dismiss", { user: payload.user.id, action });
  if (!payload.response_url) return;
  await deleteOriginal(payload.response_url);
}

/**
 * Room "Join" click → mint the member's personal link and answer with the join ephemeral.
 *
 * `origin` is the Worker's public origin (from the inbound request URL), used to build the
 * `/join/<token>` redirect the ☕ Join button points at.
 */
export async function handleJoinClick(
  payload: SlackBlockActionsPayload,
  env: Env,
  origin: string,
): Promise<void> {
  const slackUserId = payload.user.id;
  const responseUrl = payload.response_url;

  if (!responseUrl) {
    log.warn("join.no_response_url", { user: slackUserId });
    return;
  }

  // Resolve a display name to pre-fill on the invite link (and to correlate the Zoom join later).
  let displayName = "VirtualCoffee member";
  try {
    const client = createSlackClient(env);
    const res = await client.users.profile.get({ user: slackUserId });
    displayName = res.profile?.display_name || res.profile?.real_name || displayName;
  } catch {
    // Keep the default; a missing display name shouldn't block registration.
  }

  // Mint the invite link and answer with the per-user ephemeral (☕ Join / Cancel).
  try {
    log.debug("join.request", { user: slackUserId });
    const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
    const { token } = await stub.handleJoinRequest({ slackUserId, displayName });
    log.info("join.linked", { user: slackUserId }); // never log the token — it resolves to a credential
    const joinUrl = `${origin}/join/${token}`;
    const attachments = buildJoinEphemeralAttachments(env, joinUrl);
    await respondEphemeral(responseUrl, joinEphemeralText(env), undefined, attachments);
  } catch (err) {
    log.error("join.failed", { user: slackUserId, err: String(err) });
    await respondEphemeral(responseUrl, joinErrorText(env));
  }
}
