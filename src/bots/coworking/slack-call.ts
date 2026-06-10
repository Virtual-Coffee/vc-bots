import type { AnyMessageBlock } from "slack-web-api-client";
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

/** action_id of the ephemeral's personal join-link button. Slack still sends a `block_actions`
 *  interaction for url buttons (the browser follows the url); the router uses that click to
 *  delete the ephemeral — the surface closes itself after opening Zoom. */
export const JOIN_REDIRECT_ACTION_ID = "coworking_open_zoom";

/** action_id of the ephemeral's Cancel button — its click just deletes the ephemeral. */
export const CANCEL_ACTION_ID = "coworking_cancel";

/** action_id of the room "Join" button — its click mints the per-user join ephemeral. */
export const JOIN_ACTION_ID = "coworking_join";

/** Fallback `text` for the join ephemeral (clients that can't render blocks). */
export function joinEphemeralText(env: Env): string {
  return `You're all set for the ${env.ROOM_TITLE}!`;
}

/**
 * The per-user "you're all set" ephemeral (visible only to the clicker), sent via the room
 * button's `response_url`. Two buttons, mirroring the old native confirm dialog: ☕ Join (a `url`
 * button to the member's personal link — its click also deletes the ephemeral) and Cancel (just
 * deletes it). Either way the surface disappears on click, which a modal can't do.
 *
 * `joinUrl` is the Worker's `/join/<token>` redirect, not the raw Zoom link — so the hover
 * tooltip Slack pins to url buttons shows a clean URL instead of the token-bearing Zoom one.
 */
export function buildJoinEphemeralBlocks(env: Env, joinUrl: string): AnyMessageBlock[] {
  return [
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
        {
          type: "button",
          action_id: CANCEL_ACTION_ID,
          text: { type: "plain_text", text: "Cancel", emoji: true },
        },
      ],
    },
  ] as AnyMessageBlock[];
}

/** Fallback ephemeral text when minting the invite link fails. */
export function joinErrorText(env: Env): string {
  return (
    ":warning: Sorry — we couldn't set up your join link just now. " +
    `Please try again in a moment, or head to <#${env.SLACK_COWORKING_CHANNEL_ID}>.`
  );
}
