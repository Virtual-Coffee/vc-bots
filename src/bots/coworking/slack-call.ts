import type { AnyMessageBlock, ModalView } from "slack-web-api-client";
import type { Env } from "../../env";
import { formatDuration, roomClosedText } from "./zoom-events";

/**
 * Slack message blocks for the co-working room.
 *
 * The room used to mirror a native Slack Call, but that widget only supports a single shared
 * "Join" url. Instead we render our own message: the ☕ Join button (a modal trigger that hands
 * each member a personal invite link) plus a live presence list we keep up to date by editing
 * the message as people join/leave.
 */

/** A person currently in the room: a correlated member (`slackUserId`) or an external guest. */
export type PresenceUser = { slackUserId: string } | { displayName: string };

/**
 * Render the "who's in the room" line. Members show as `<@id>` mentions (links their profile);
 * guests show as their plain display name. Empty → a gentle "nobody here yet" nudge.
 */
export function formatPresence(present: PresenceUser[]): string {
  if (present.length === 0) return ":wave: Nobody's in the room yet — be the first to hop in!";
  const names = present.map((p) =>
    "slackUserId" in p ? `<@${p.slackUserId}>` : p.displayName,
  );
  return `:busts_in_silhouette: In the room (${present.length}): ${names.join(", ")}`;
}

/** End-of-session stats for the closed message. */
export interface SessionStats {
  durationMs: number;
  peak: number;
  /** Everyone who stopped by (deduped): members as mentions, guests as plain names. */
  attendees: PresenceUser[];
}

/** Render a roster as a comma-separated list — members as `<@id>` mentions, guests as plain names. */
function formatRoster(attendees: PresenceUser[]): string {
  const names = attendees.map((p) =>
    "slackUserId" in p ? `<@${p.slackUserId}>` : p.displayName,
  );
  return names.join(", ");
}

/**
 * A primary button that opens the per-user join modal. It carries no `url` (a channel message
 * button's url is identical for every viewer, so it can't be a per-user link); instead the click
 * posts a `block_actions` interaction with a `trigger_id`, which `handleJoinClick` uses to open a
 * modal and hand the member their personal invite link.
 */
function joinButton(label: string): AnyMessageBlock {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: JOIN_ACTION_ID,
        text: { type: "plain_text", text: label, emoji: true },
        style: "primary",
      },
    ],
  } as AnyMessageBlock;
}

/**
 * Channel message blocks for an idle room: a gentle nudge inviting someone to start a session,
 * with the same Zoom-redirect button (no live Call yet — that arrives with `meeting.started`).
 */
export function buildRoomIdleBlocks(env: Env): AnyMessageBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:coffee: The *${env.ROOM_TITLE}* is quiet right now — be the first to hop in and start a session!`,
      },
    },
    joinButton("Start the co-working room"),
  ];
}

/**
 * Channel message blocks for an open room: intro + the ☕ Join button (per-user modal) + a live
 * presence list. Re-rendered on every join/leave via `chat.update`.
 */
export function buildRoomOpenBlocks(env: Env, present: PresenceUser[]): AnyMessageBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:coffee: The *${env.ROOM_TITLE}* is now open!` },
    },
    joinButton("Join the co-working room"),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: formatPresence(present) }],
    },
  ];
}

/**
 * Channel message blocks for an ended room: a wrap-up headline plus a stats line
 * (session length, peak attendance, and a deduped list of everyone who stopped by). No Join
 * button — the session is over, and a fresh standing invite is posted separately.
 */
export function buildRoomClosedBlocks(env: Env, stats: SessionStats): AnyMessageBlock[] {
  const parts = [
    `:stopwatch: Lasted ${formatDuration(stats.durationMs)}`,
    `:busts_in_silhouette: Peak ${stats.peak}`,
  ];
  if (stats.attendees.length > 0) {
    parts.push(`:coffee: Stopped by (${stats.attendees.length}): ${formatRoster(stats.attendees)}`);
  }
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: roomClosedText(env) },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: parts.join("  ·  ") }],
    },
  ];
}

/** action_id of the modal's personal join-link button. Slack still sends a `block_actions`
 *  interaction for url buttons; the router ignores it (the browser follows the url). */
export const JOIN_REDIRECT_ACTION_ID = "coworking_open_zoom";

/** action_id of the room "Join" button — its click opens the per-user join modal. */
export const JOIN_ACTION_ID = "coworking_join";

/**
 * The "Join" modals.
 *
 * Flow: room button click → open the loading modal (uses the fresh `trigger_id`) → mint the
 * invite link → `views.update` to the link modal (or the error modal on failure). The link lives
 * on a `url` button inside the modal — a per-user surface, so it *can* be the personal join url.
 */

/** Shown immediately on click, while we mint the invite link (so we beat the ~3s trigger window). */
export function buildJoinLoadingModal(): ModalView {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Co-Working Room" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":coffee: Setting up your personal join link…" },
      },
    ],
  };
}

/** The ready modal: a Code-of-Conduct reminder + a primary button to the member's personal link. */
export function buildJoinModal(env: Env, joinUrl: string): ModalView {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Co-Working Room" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `:coffee: You're all set for the *${env.ROOM_TITLE}*!\n\n` +
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
            text: { type: "plain_text", text: "☕ Join the Co-Working Room", emoji: true },
            url: joinUrl,
            style: "primary",
          },
        ],
      },
    ],
  };
}

/** Fallback modal when minting the invite link fails. */
export function buildJoinErrorModal(env: Env): ModalView {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Co-Working Room" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            ":warning: Sorry — we couldn't set up your join link just now. " +
            `Please try again in a moment, or head to <#${env.SLACK_COWORKING_CHANNEL_ID}>.`,
        },
      },
    ],
  };
}
