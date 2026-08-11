import type { AnyMessageBlock, MessageAttachment } from "slack-cloudflare-workers";
import { DateTime } from "luxon";
import type { Env } from "../../env";
import { dateToken } from "../../slack/date";
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
 * Render the "who's in the room" portion of the open message. Empty → a gentle "nobody here
 * yet" context nudge. Otherwise a context label plus a rich-text bulleted list — members as
 * real `user` mention elements (links their profile), guests as plain text.
 */
function presenceBlocks(present: PresenceUser[]): AnyMessageBlock[] {
  if (present.length === 0) {
    return [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: ":wave: Nobody's in the room yet — be the first to hop in!",
          },
        ],
      },
    ];
  }
  return [
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `:busts_in_silhouette: *In the room (${present.length}):*` },
      ],
    },
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          elements: present.map((p) => ({
            type: "rich_text_section" as const,
            elements: [
              "slackUserId" in p
                ? { type: "user" as const, user_id: p.slackUserId }
                : { type: "text" as const, text: p.displayName },
            ],
          })),
        },
      ],
    },
  ];
}

/**
 * A session instant as a per-viewer Slack date token. The DateTime is anchored to Eastern so the
 * plain-text fallback reads unambiguously (`9:03 AM EDT`) for clients that can't render the token;
 * everyone else sees their own timezone.
 */
function sessionTimeToken(ms: number): string {
  return dateToken(DateTime.fromMillis(ms, { zone: "America/New_York" }), "{time}", "t ZZZZ");
}

/** End-of-session stats for the closed message. */
export interface SessionStats {
  /** Session bookends. Nullable — `session.started_at` is nullable in the DO schema. */
  startedAtMs?: number | null;
  endedAtMs?: number | null;
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

/** The nudge above the ended message's "start the next session" button. */
const ROOM_INVITE_NUDGE =
  "The room's quiet now — be the first to hop in and start the next session!";

/**
 * Channel message blocks for an open room: a full card — header, intro, how long the room has been
 * running, the ☕ Join button (per-user ephemeral), and a live presence list rendered as a
 * rich-text bulleted roster. Re-rendered on every join/leave via `chat.update`.
 *
 * `startedAtMs` is omitted by the admin announce-only path, which posts a room-open message with no
 * tracked session behind it — no session, no start time, so the line simply doesn't render.
 */
export function buildRoomOpenBlocks(
  env: Env,
  present: PresenceUser[],
  startedAtMs?: number | null,
): AnyMessageBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `☕ The ${env.ROOM_TITLE} is open!`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Hop in for some focused work alongside friendly faces." },
    },
    ...(startedAtMs
      ? ([
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `:clock3: Session started at ${sessionTimeToken(startedAtMs)}` },
            ],
          },
        ] satisfies AnyMessageBlock[])
      : []),
    joinButton("Join the co-working room"),
    ...presenceBlocks(present),
  ];
}

/**
 * Channel message blocks for an ended room: a full card — wrap-up header, the closed line, the
 * session bookends and totals as section fields, and a deduped "Dropped in" roster as fine print.
 *
 * The ended message is also where the next session begins: by default it carries the invite CTA
 * (nudge + Join button) below the stats, so there's no separate standing-invite message and the
 * next `meeting.started` can post a *fresh* message — which is what makes Slack notify the channel
 * that the room opened. Pass `{ invite: false }` to render the stats alone; that's how the previous
 * session's card is retired once a new session takes over as the live CTA.
 *
 * Slack flows `fields` into two columns in order, so Started/Ended/Duration/Peak reads as a 2×2
 * grid. Each timestamp is guarded independently (`started_at` is nullable in the DO schema — the
 * same reason `durationMs` degrades to 0); with both absent this falls back to the original
 * Duration | Peak row.
 */
export function buildRoomClosedBlocks(
  env: Env,
  stats: SessionStats,
  { invite = true }: { invite?: boolean } = {},
): AnyMessageBlock[] {
  const fields: { type: "mrkdwn"; text: string }[] = [];
  if (stats.startedAtMs) {
    fields.push({ type: "mrkdwn", text: `:clock3: *Started:* ${sessionTimeToken(stats.startedAtMs)}` });
  }
  if (stats.endedAtMs) {
    fields.push({
      type: "mrkdwn",
      text: `:checkered_flag: *Ended:* ${sessionTimeToken(stats.endedAtMs)}`,
    });
  }
  fields.push(
    { type: "mrkdwn", text: `:stopwatch: *Duration:* ${formatDuration(stats.durationMs)}` },
    { type: "mrkdwn", text: `:busts_in_silhouette: *Peak:* ${stats.peak}` },
  );

  const blocks: AnyMessageBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🎉 That's a wrap!", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: roomClosedText(env) },
    },
    { type: "section", fields },
  ];
  if (stats.attendees.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:coffee: Dropped in (${stats.attendees.length}): ${formatRoster(stats.attendees)}`,
        },
      ],
    });
  }
  if (invite) {
    blocks.push(
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: ROOM_INVITE_NUDGE } },
      joinButton("Start the co-working room"),
    );
  }
  return blocks;
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
export function buildJoinEphemeralAttachments(env: Env, joinUrl: string): MessageAttachment[] {
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
export function joinErrorText(env: Env): string {
  return (
    ":warning: Sorry — we couldn't set up your join link just now. " +
    `Please try again in a moment, or head to <#${env.SLACK_COWORKING_CHANNEL_ID}>.`
  );
}
