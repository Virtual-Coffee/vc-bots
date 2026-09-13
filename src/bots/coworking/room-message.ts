import { SlackAPIError, type AnyMessageBlock } from "slack-cloudflare-workers";
import { DateTime } from "luxon";
import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { dateToken } from "../../slack/date";

/**
 * The room message — the single channel message that represents one session (or one
 * announcement) for its whole life: posted as an open card, edited in place into an ended card.
 *
 * `RoomMessage` owns everything Slack-message-shaped about the co-working room: the Block Kit
 * cards, the copy, the standing-invite hand-off between cards, and the cross-session pointers
 * that make the hand-off possible. The `CoworkingRoom` Durable Object keeps the session state
 * machine and tells this module *what* happened (`open` / `showPresence` / `close` /
 * `announceOpen` / `announceClose`); the module decides what the channel should look like.
 *
 * Slack itself sits behind `RoomChannelPort` — three calls (post / update / delete) against the
 * co-working channel — so the message lifecycle is testable against a fake port with no network.
 *
 * Standing-invite chain: every ended card is rendered with the "start the next session" button,
 * and the most recent one is remembered as the *last closed card*. When a newer room message
 * takes over (a session start or an announcement), `retirePrevious` re-renders the remembered
 * card without the button, so exactly one standing invite exists at a time. Announcements join
 * the same chain: `announceClose` turns the announcement into an ended card that becomes the last
 * closed card, and a lingering open announcement is closed (without invite) by `retirePrevious`.
 */

/** The seam to Slack: the three operations the room message needs against the co-working channel. */
export interface RoomChannelPort {
  /** Post a new message; resolves to its ts, or null when Slack returned none. */
  post(text: string, blocks: AnyMessageBlock[]): Promise<string | null>;
  /**
   * Edit a message in place. A vanished target (deleted by hand, or a ts minted against another
   * channel — a stale dev pointer) resolves to `"vanished"` so callers can move on instead of
   * wedging the room on a dead ts. Any other failure throws.
   */
  update(ts: string, text: string, blocks: AnyMessageBlock[]): Promise<"ok" | "vanished">;
  delete(ts: string): Promise<void>;
}

/** The slice of Durable Object storage the room message keeps its pointers in. */
export type RoomMessageStorage = Pick<DurableObjectStorage, "get" | "put" | "delete">;

/** A person currently in the room: a member (`slackUserId`) or a guest (`displayName`). */
export type PresenceUser = { slackUserId: string } | { displayName: string };

/** End-of-session stats for the ended card. */
export interface SessionStats {
  /** Session bookends. Nullable — `session.started_at` is nullable in the DO schema. */
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  durationMs: number;
  peak: number;
  /** The roster — everyone who dropped in (deduped): members as mentions, guests as plain names. */
  attendees: PresenceUser[];
}

/** action_id of the room message's Join button — its click mints the per-user join ephemeral. */
export const JOIN_ACTION_ID = "coworking_join";

/**
 * Storage key of the last closed card — the ended card carrying the standing invite until the
 * next room message retires it. The cached value is the `SessionStats` rather than rendered
 * blocks: `participant` rows are deleted at close, so the card can't be re-derived from SQL later,
 * and stats survive future block-shape changes. (Key name predates this module; kept so a
 * deployed DO's pointer carries over.)
 */
const LAST_CLOSED_KEY = "last_closed_message";

/** Storage key of the open announcement (an admin-posted room message with no session behind it). */
const ANNOUNCEMENT_KEY = "room_message:announcement";

/** Storage key of the retired lifecycle's standing-invite message, cleaned up once and forgotten. */
const LEGACY_ROOM_MESSAGE_KEY = "idle_invite_ts";

type LastClosed = { ts: string; stats: SessionStats };
type Announcement = { ts: string; openedAtMs: number };

export class RoomMessage {
  private readonly roomTitle: string;

  constructor(
    private readonly port: RoomChannelPort,
    private readonly storage: RoomMessageStorage,
    env: Pick<Env, "ROOM_TITLE">,
  ) {
    this.roomTitle = env.ROOM_TITLE;
  }

  /**
   * Post a fresh open card for a session that just started. Always a NEW message, never an edit
   * of the previous card: a fresh post is what makes Slack notify the channel that the room just
   * opened (an edit is silent). Resolves to the message ts, or null when Slack returned none.
   */
  async open(startedAtMs: number): Promise<string | null> {
    log.debug("coworking.room_msg.open");
    const ts = await this.port.post(
      roomOpenText(this.roomTitle),
      buildRoomOpenBlocks(this.roomTitle, [], startedAtMs),
    );
    if (!ts) log.warn("coworking.room_msg.no_ts");
    return ts;
  }

  /**
   * Re-render the open card's presence list. A vanished message just warns (in the port) and
   * skips — a join/leave webhook must never throw over it; `close` will report the same.
   */
  async showPresence(
    ts: string,
    present: PresenceUser[],
    startedAtMs: number | null,
  ): Promise<void> {
    log.debug("coworking.presence.update", { ts, count: present.length });
    await this.port.update(
      ts,
      roomOpenText(this.roomTitle),
      buildRoomOpenBlocks(this.roomTitle, present, startedAtMs),
    );
  }

  /**
   * Edit the session's card into the ended card, standing invite included, and remember it as
   * the last closed card so the next room message can retire it. If the card vanished
   * mid-session there's simply nothing left to carry the invite: warn (in the port) and remember
   * nothing.
   */
  async close(ts: string, stats: SessionStats): Promise<void> {
    log.debug("coworking.room_msg.close", { ts, peak: stats.peak });
    const result = await this.port.update(
      ts,
      roomClosedText(this.roomTitle),
      buildRoomClosedBlocks(this.roomTitle, stats),
    );
    if (result === "ok") await this.storage.put<LastClosed>(LAST_CLOSED_KEY, { ts, stats });
  }

  /**
   * A newer room message is taking over: strip the standing invite from whatever carried it so
   * only one exists at a time. Each step is best-effort on its own.
   *
   * 1. The last closed card is re-rendered without the invite (from its cached stats — the
   *    roster is gone from SQL by now).
   * 2. A lingering open announcement is closed without the invite (announced-at as Started, now
   *    as Ended, no roster).
   * 3. One-shot legacy cleanup: the retired lifecycle's standing-invite message carried no
   *    history worth keeping, so it's deleted outright rather than left with a live button.
   */
  async retirePrevious(): Promise<void> {
    const last = await this.storage.get<LastClosed>(LAST_CLOSED_KEY);
    if (last) {
      log.debug("coworking.room_msg.retire", { ts: last.ts });
      await this.port.update(
        last.ts,
        roomClosedText(this.roomTitle),
        buildRoomClosedBlocks(this.roomTitle, last.stats, { invite: false }),
      );
      await this.storage.delete(LAST_CLOSED_KEY);
    }

    const announcement = await this.storage.get<Announcement>(ANNOUNCEMENT_KEY);
    if (announcement) {
      log.debug("coworking.room_msg.retire_announcement", { ts: announcement.ts });
      await this.port.update(
        announcement.ts,
        roomClosedText(this.roomTitle),
        buildRoomClosedBlocks(this.roomTitle, announcementStats(announcement, Date.now()), {
          invite: false,
        }),
      );
      await this.storage.delete(ANNOUNCEMENT_KEY);
    }

    const legacyTs = await this.storage.get<string>(LEGACY_ROOM_MESSAGE_KEY);
    if (legacyTs) {
      try {
        await this.port.delete(legacyTs);
      } catch (err) {
        log.warn("coworking.legacy_invite.delete_failed", { ts: legacyTs, err: String(err) });
      }
      await this.storage.delete(LEGACY_ROOM_MESSAGE_KEY);
    }
  }

  /**
   * Admin announcement (`/vc-bot-admin coworking open`): an open card with no session behind it —
   * no presence, no start line — but the Join button works as ever. It takes over as the newest
   * room message, so the previous standing invite is retired first.
   */
  async announceOpen(): Promise<void> {
    await this.retirePrevious();
    const ts = await this.port.post(
      roomOpenText(this.roomTitle),
      buildRoomOpenBlocks(this.roomTitle, []),
    );
    if (ts) {
      await this.storage.put<Announcement>(ANNOUNCEMENT_KEY, { ts, openedAtMs: Date.now() });
    } else {
      log.warn("coworking.room_msg.no_ts");
    }
    log.info("coworking.admin_announce", { action: "open", ts });
  }

  /**
   * Admin (`/vc-bot-admin coworking close`): edit the open announcement into an ended card that
   * carries the standing invite — it becomes the last closed card like any session's. The
   * announcement pointer is spent either way: a vanished announcement counts as nothing to close.
   */
  async announceClose(): Promise<{ closed: boolean }> {
    const announcement = await this.storage.get<Announcement>(ANNOUNCEMENT_KEY);
    if (!announcement) return { closed: false };
    const stats = announcementStats(announcement, Date.now());
    const result = await this.port.update(
      announcement.ts,
      roomClosedText(this.roomTitle),
      buildRoomClosedBlocks(this.roomTitle, stats),
    );
    await this.storage.delete(ANNOUNCEMENT_KEY);
    const closed = result === "ok";
    if (closed) {
      await this.storage.put<LastClosed>(LAST_CLOSED_KEY, { ts: announcement.ts, stats });
    }
    log.info("coworking.admin_announce", { action: "close", closed });
    return { closed };
  }
}

/** Stats for an announcement's ended card: bookends only — no session, so no peak and no roster. */
function announcementStats(announcement: Announcement, endedAtMs: number): SessionStats {
  return {
    startedAtMs: announcement.openedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - announcement.openedAtMs),
    peak: 0,
    attendees: [],
  };
}

// --- Slack adapter ---

/** The real `RoomChannelPort`: the bot's Slack client against the co-working channel. */
export function createSlackRoomChannelPort(env: Env): RoomChannelPort {
  const channel = env.SLACK_COWORKING_CHANNEL_ID;
  return {
    async post(text, blocks) {
      const res = await createSlackClient(env).chat.postMessage({ channel, text, blocks });
      return res.ts ?? null;
    },
    async update(ts, text, blocks) {
      try {
        await createSlackClient(env).chat.update({ channel, ts, text, blocks });
        return "ok";
      } catch (err) {
        const code = err instanceof SlackAPIError ? err.error : String(err);
        if (code.includes("message_not_found") || code.includes("channel_not_found")) {
          log.warn("coworking.room_msg.stale_pointer", { ts, error: code });
          return "vanished";
        }
        throw err;
      }
    },
    async delete(ts) {
      await createSlackClient(env).chat.delete({ channel, ts });
    },
  };
}

// --- Copy ---

/** Fallback `text` of the open card (clients that can't render blocks). */
function roomOpenText(roomTitle: string): string {
  return `:coffee: The *${roomTitle}* is now open! Tap Join to hop in.`;
}

/** Fallback `text` of the ended card; also its closed line. */
function roomClosedText(roomTitle: string): string {
  return `:zzz: The *${roomTitle}* session has ended. Start a new one any time!`;
}

/** Human-friendly session length: `"1h 23m"`, `"45m"`, or `"<1m"` for anything under a minute. */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** The nudge above the ended card's "start the next session" button. */
const ROOM_INVITE_NUDGE =
  "The room's quiet now — be the first to hop in and start the next session!";

// --- Block Kit ---
//
// The room used to mirror a native Slack Call, but that widget only supports a single shared
// "Join" url. Instead we render our own message: the ☕ Join button (hands each member a personal
// invite link via an ephemeral) plus a live presence list we keep up to date by editing the
// message as people join/leave.

/**
 * Render the presence portion of the open card. Empty → a gentle "nobody here yet" context
 * nudge. Otherwise a context label plus a rich-text bulleted list — members as real `user`
 * mention elements (links their profile), guests as plain text.
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

/** Render a roster as a comma-separated list — members as `<@id>` mentions, guests as plain names. */
function formatRoster(attendees: PresenceUser[]): string {
  const names = attendees.map((p) =>
    "slackUserId" in p ? `<@${p.slackUserId}>` : p.displayName,
  );
  return names.join(", ");
}

/**
 * A primary button that mints the per-user join ephemeral. It carries no `url` (a channel message
 * button's url is identical for every viewer, so it can't be a per-user link); instead the click
 * posts a `block_actions` interaction, which `handleJoinClick` answers with the member's personal
 * invite link.
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
 * The open card: header, intro, how long the room has been running, the ☕ Join button (per-user
 * ephemeral), and a live presence list rendered as a rich-text bulleted roster. Re-rendered on
 * every join/leave via `chat.update`.
 *
 * `startedAtMs` is omitted by an announcement, which has no session behind it — no session, no
 * start time, so the line simply doesn't render.
 */
function buildRoomOpenBlocks(
  roomTitle: string,
  present: PresenceUser[],
  startedAtMs?: number | null,
): AnyMessageBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `☕ The ${roomTitle} is open!`, emoji: true },
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
 * The ended card: wrap-up header, the closed line, the session bookends and totals as section
 * fields, and the deduped "Dropped in" roster as fine print.
 *
 * The ended card is also where the next session begins: by default it carries the standing
 * invite (nudge + Join button) below the stats, so there's no separate invite message and the
 * next `meeting.started` can post a *fresh* message — which is what makes Slack notify the channel
 * that the room opened. Pass `{ invite: false }` to render the stats alone; that's how a card is
 * retired once a newer room message takes over.
 *
 * Slack flows `fields` into two columns in order, so Started/Ended/Duration/Peak reads as a 2×2
 * grid. Each timestamp is guarded independently (`started_at` is nullable in the DO schema — the
 * same reason `durationMs` degrades to 0); with both absent this falls back to the original
 * Duration | Peak row.
 */
function buildRoomClosedBlocks(
  roomTitle: string,
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
      text: { type: "mrkdwn", text: roomClosedText(roomTitle) },
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
