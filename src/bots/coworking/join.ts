import type { AnyMessageBlock, MessageAttachment } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { notifyBotLog } from "../../slack/notify";
import { deleteOriginal, respondEphemeral } from "../../slack/response";

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

/** action_id of the ephemeral's personal join-link button. Slack still sends a `block_actions`
 *  interaction for url buttons (the browser follows the url); the router uses that click to
 *  delete the ephemeral — the surface closes itself after opening Zoom. */
export const JOIN_REDIRECT_ACTION_ID = "coworking_open_zoom";

/** action_id of the ephemeral's Cancel button — its click just deletes the ephemeral. */
export const CANCEL_ACTION_ID = "coworking_cancel";

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
    // Tell maintainers the room join is broken (Zoom invite-link mint / DO call failed).
    await notifyBotLog(env, "join.failed", { user: slackUserId, err: String(err) });
  }
}

// --- The join ephemeral ---

/** Fallback `text` for the join ephemeral (clients that can't render blocks). */
export function joinEphemeralText(env: Pick<Env, "ROOM_TITLE">): string {
  return `You're all set for the ${env.ROOM_TITLE}!`;
}

/**
 * The per-user invitation ephemeral (visible only to the clicker), sent via the room button's
 * `response_url`. The whole invitation rides in one message attachment so Slack draws the VC
 * raspberry accent bar down its left edge — the message-safe stand-in for a card (the newer
 * `card` and `alert` block types are rejected as invalid_blocks in messages). Inside: a header,
 * the room/intro line, the Code of Conduct as its own section, then the two buttons mirroring the
 * old native confirm dialog — ☕ Join (a `url` button to the member's personal link — its click
 * also deletes the ephemeral) and Cancel (just deletes it). Either way the surface disappears
 * on click, which a modal can't do.
 *
 * `joinUrl` is the Worker's `/join/<token>` redirect, not the raw Zoom link — so the hover
 * tooltip Slack pins to url buttons shows a clean URL instead of the token-bearing Zoom one.
 */
export function buildJoinEphemeralAttachments(
  env: Pick<Env, "ROOM_TITLE">,
  joinUrl: string,
): MessageAttachment[] {
  const blocks: AnyMessageBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🎉 You're invited!", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${env.ROOM_TITLE}* · happening now\n` +
          "Grab your drink — your personal join link is ready, and it's just for you.",
      },
    },
    // The Code of Conduct sits above the buttons so it's read before joining.
    {
      type: "section",
      text:
        {
          type: "mrkdwn",
          text:
            "By joining, you agree to follow our " +
            "<https://virtualcoffee.io/code-of-conduct|Code of Conduct>. " +
            "Be kind, keep it welcoming, and enjoy the company. :heart:",
        },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: JOIN_REDIRECT_ACTION_ID,
          text: { type: "plain_text", text: "☕️  Join now", emoji: true },
          url: joinUrl,
          style: "primary",
        },
        {
          type: "button",
          action_id: CANCEL_ACTION_ID,
          text: { type: "plain_text", text: "Cancel", emoji: true },
          style: "danger"
        },
      ],
    },
  ];
  return [
    {
      color: "#d9376e", // VirtualCoffee brand raspberry — the accent bar
      fallback: joinEphemeralText(env),
      blocks,
    },
  ];
}

/** Fallback ephemeral text when minting the invite link fails. */
export function joinErrorText(env: Pick<Env, "SLACK_COWORKING_CHANNEL_ID">): string {
  return (
    ":warning: Sorry — we couldn't set up your join link just now. " +
    `Please try again in a moment, or head to <#${env.SLACK_COWORKING_CHANNEL_ID}>.`
  );
}
