import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import type { SlackBlockActionsPayload } from "../../slack/types";
import {
  JOIN_ACTION_ID,
  buildJoinErrorModal,
  buildJoinLoadingModal,
  buildJoinModal,
} from "./slack-call";

/**
 * Interactivity handler for the room "Join" button.
 *
 * The route ACKs Slack within 3s and calls this via `ctx.waitUntil`. A channel button's url is
 * identical for every viewer, so it can't carry a per-user link; instead the click opens a modal
 * (a per-user surface). We open a loading modal immediately — while the `trigger_id` is still
 * fresh — then mint the member's Zoom invite link and `views.update` the modal with their personal
 * join link (or an error modal if minting fails).
 */

/** Does this interactivity payload represent a click of the room "Join" button? */
export function isJoinClick(payload: SlackBlockActionsPayload): boolean {
  return (
    payload.type === "block_actions" &&
    Boolean(payload.actions?.some((a) => a.action_id === JOIN_ACTION_ID))
  );
}

export async function handleJoinClick(
  payload: SlackBlockActionsPayload,
  env: Env,
): Promise<void> {
  const slackUserId = payload.user.id;
  const triggerId = payload.trigger_id;
  const client = createSlackClient(env);

  if (!triggerId) {
    log.warn("join.no_trigger", { user: slackUserId });
    return;
  }

  // Open the loading modal first, while the trigger_id is fresh (Slack's ~3s window).
  let viewId: string | undefined;
  try {
    log.debug("join.modal.open", { user: slackUserId });
    const opened = await client.views.open({ trigger_id: triggerId, view: buildJoinLoadingModal() });
    viewId = opened.view?.id;
  } catch (err) {
    log.warn("join.modal.open_failed", { user: slackUserId, err: String(err) });
    return; // no modal → nothing more we can do for this click
  }

  // Resolve a display name to pre-fill on the invite link (and to correlate the Zoom join later).
  let displayName = "VirtualCoffee member";
  try {
    const res = await client.users.profile.get({ user: slackUserId });
    displayName = res.profile?.real_name || res.profile?.display_name || displayName;
  } catch {
    // Keep the default; a missing display name shouldn't block registration.
  }

  // Mint the invite link and swap the loading modal for the personal-link modal.
  try {
    log.debug("join.request", { user: slackUserId });
    const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
    const { joinUrl } = await stub.handleJoinRequest({ slackUserId, displayName });
    log.info("join.linked", { user: slackUserId }); // never log joinUrl — it's a credential
    await client.views.update({ view_id: viewId, view: buildJoinModal(env, joinUrl) });
  } catch (err) {
    log.error("join.failed", { user: slackUserId, err: String(err) });
    await client.views.update({ view_id: viewId, view: buildJoinErrorModal(env) });
  }
}
