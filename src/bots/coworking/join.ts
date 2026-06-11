import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { deleteOriginal, respondEphemeral } from "../../slack/response";
import {
  buildJoinEphemeralAttachments,
  joinEphemeralText,
  joinErrorText,
} from "./slack-call";

/**
 * Interactivity handlers for the room "Join" button and the per-user join ephemeral,
 * registered as `.action()` lazy listeners in `src/slack/app.ts` (the app ACKs Slack within
 * 3s and runs these via `ctx.waitUntil`). A channel button's url is identical for every
 * viewer, so it can't carry a per-user link; instead the click mints the member's invite
 * link and posts an ephemeral (a per-user surface) via the click's `response_url`: a
 * Code-of-Conduct note plus ☕ Join / Cancel buttons. Clicking either button deletes the
 * ephemeral (☕ Join also opens Zoom via its `url`), so the surface closes itself — the
 * confirm-dialog feel a modal can't offer (Slack has no API to close a modal from a button click).
 *
 * The ☕ Join url is the Worker's `/join/<token>` redirect, not the raw Zoom link, so Slack's
 * hover tooltip never exposes the token-bearing personal join url.
 */

/**
 * The `block_actions` fields these handlers read — a structural subset of the framework's
 * `BlockAction` payload, kept narrow so tests can construct it directly.
 */
export interface JoinActionPayload {
  user: { id: string };
  response_url?: string;
  actions: { action_id: string }[];
}

/**
 * Delete the join ephemeral after either of its buttons is clicked. For ☕ Join the browser is
 * already opening the url client-side; this just makes the message vanish behind it.
 */
export async function handleJoinDismiss(
  payload: JoinActionPayload,
  _env: Env,
): Promise<void> {
  const action = payload.actions[0]?.action_id ?? "unknown";
  log.info("join.dismiss", { user: payload.user.id, action });
  if (!payload.response_url) return;
  await deleteOriginal(payload.response_url);
}

/**
 * Room "Join" click → mint the member's personal link and answer with the join ephemeral.
 *
 * `publicBaseUrl` is the base the `/join/<token>` redirect is surfaced under — the public
 * base URL (`PUBLIC_BASE_URL`, may include a path prefix like `/bots`) or the request origin.
 */
export async function handleJoinClick(
  payload: JoinActionPayload,
  env: Env,
  publicBaseUrl: string,
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
    const joinUrl = `${publicBaseUrl}/join/${token}`;
    const attachments = buildJoinEphemeralAttachments(env, joinUrl);
    await respondEphemeral(responseUrl, joinEphemeralText(env), undefined, attachments);
  } catch (err) {
    log.error("join.failed", { user: slackUserId, err: String(err) });
    await respondEphemeral(responseUrl, joinErrorText(env));
  }
}
