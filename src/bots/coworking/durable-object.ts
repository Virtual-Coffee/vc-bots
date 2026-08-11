import { DurableObject } from "cloudflare:workers";
import { SlackAPIError, type AnyMessageBlock } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log, setLogLevel } from "../../log";
import { createSlackClient } from "../../slack/client";
import { getCachedZoomToken } from "../../zoom/oauth";
import { createInviteLink } from "../../zoom/invite-links";
import type { ZoomMeetingEvent } from "../../zoom/types";
import {
  type PresenceUser,
  type SessionStats,
  buildRoomClosedBlocks,
  buildRoomOpenBlocks,
} from "./slack-call";
import {
  eventTimeMs,
  instanceUuid,
  participantIdentity,
  roomClosedText,
  roomOpenText,
} from "./zoom-events";

/**
 * Co-working room — one Durable Object instance per Zoom meeting ID. All events for a meeting
 * serialize through this single instance, so the session row is always written before a join
 * is processed (no eventual-consistency race).
 *
 * Mints per-user Zoom invite links (name pre-filled), posts a self-managed room message, and keeps
 * its presence list in sync as people join/leave.
 *
 * Message lifecycle: each `meeting.started` posts a NEW channel message (so Slack notifies the
 * channel that the room is open), edits it in place through the session's joins and leaves, and on
 * close turns it into the stats summary — which also carries the "start a new session" button until
 * the next session start strips it. One message per session, one live CTA at a time.
 */

/** Force-end a session this long after it started if `meeting.ended` was never received. */
const STALE_SESSION_MS = 18 * 60 * 60 * 1000;

/** Lifetime of a `/join/<token>` redirect — matches the Zoom invite link's own TTL
 *  (`DEFAULT_TTL` in zoom/invite-links.ts), past which the link is dead anyway. */
const INVITE_LINK_TTL_MS = 7200 * 1000;

/** 128-bit random, url-safe token for the `/join/<token>` redirect (Web Crypto only). */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** DO storage key for the ts of an admin-posted (announce-only) room message. */
const ADMIN_ANNOUNCEMENT_KEY = "admin_announcement_ts";

/**
 * DO storage key for the last ended-session message — the one carrying the live "start a new
 * session" CTA until the next `meeting.started` retires it. The cached value is the `SessionStats`
 * rather than rendered blocks: `participant` rows are deleted at close, so the card can't be
 * re-derived from SQL later, and stats survive future block-shape changes.
 */
const LAST_CLOSED_KEY = "last_closed_message";

/** Storage key of the retired standing-invite pointer, cleaned up on the next session start. */
const LEGACY_ROOM_MESSAGE_KEY = "idle_invite_ts";

type LastClosed = { ts: string; stats: SessionStats };

// Type aliases (not interfaces) so they satisfy `exec<T>`'s `Record<string, SqlStorageValue>`.
type SessionRow = {
  instance_uuid: string;
  slack_message_ts: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: string;
  peak_participants: number | null;
};

type MemberLinkRow = {
  slack_user_id: string;
  display_name: string | null;
  created_at: number | null;
};

type ParticipantRow = {
  zoom_user_id: string;
  instance_uuid: string;
  slack_user_id: string | null;
  external_id: string | null;
  display_name: string | null;
  joined_at: number | null;
  left_at: number | null;
};

export class CoworkingRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL); // the DO runs in its own isolate
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session (
        instance_uuid     TEXT PRIMARY KEY,
        slack_message_ts  TEXT,
        started_at        INTEGER,
        ended_at          INTEGER,
        status            TEXT NOT NULL,
        peak_participants INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS member_link (
        slack_user_id   TEXT PRIMARY KEY,
        display_name    TEXT,
        created_at      INTEGER
      );
      CREATE TABLE IF NOT EXISTS participant (
        zoom_user_id    TEXT,
        instance_uuid   TEXT,
        slack_user_id   TEXT,
        external_id     TEXT,
        display_name    TEXT,
        joined_at       INTEGER,
        left_at         INTEGER,
        PRIMARY KEY (zoom_user_id, instance_uuid)
      );
      CREATE TABLE IF NOT EXISTS invite_link (
        token         TEXT PRIMARY KEY,
        join_url      TEXT NOT NULL,
        slack_user_id TEXT,
        expires_at    INTEGER NOT NULL
      );
    `);
    // Backfill columns for DOs created before these were added. ADD COLUMN throws on an existing
    // column, so guard with table_info to keep migrate() idempotent under blockConcurrencyWhile.
    this.addColumnIfMissing("session", "peak_participants", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("participant", "left_at", "INTEGER");
  }

  /** Add a column only if it's not already present (idempotent schema migration). */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const exists = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((c) => c.name === column);
    if (!exists) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // --- RPC surface ---

  /**
   * Slack Join click → mint a per-user Zoom invite link (name pre-filled) and return an opaque
   * token for it. The raw `join_url` never leaves the DO: the join button points at the Worker's
   * `/join/<token>` redirect, which calls `resolveJoinToken` — so the token-bearing Zoom url
   * appears nowhere in the Slack UI (and, as ever, nowhere in logs).
   *
   * We store `slack_user_id ↔ display_name` so we can correlate the member later. Correlation is
   * best-effort: an invite-link joiner's `participant_joined` carries no registrant id, only the
   * `user_name` we baked in here — so we match on that name (and fall back to a plain guest when a
   * signed-in member's own Zoom name overrides the pre-fill). No member PII is sent to Zoom.
   */
  async handleJoinRequest(input: {
    slackUserId: string;
    displayName: string;
  }): Promise<{ token: string }> {
    log.debug("coworking.join.token", { user: input.slackUserId });
    const accessToken = await getCachedZoomToken(this.env, this.ctx.storage);
    log.debug("coworking.join.invite_link", { user: input.slackUserId });
    const { joinUrl } = await createInviteLink(
      accessToken,
      this.env.ZOOM_MEETING_ID,
      input.displayName,
    );

    log.debug("coworking.join.store", { user: input.slackUserId });
    this.sql.exec(
      `INSERT INTO member_link (slack_user_id, display_name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(slack_user_id) DO UPDATE SET
         display_name = excluded.display_name, created_at = excluded.created_at`,
      input.slackUserId,
      input.displayName,
      Date.now(),
    );

    // Opaque redirect token, expiring with the Zoom link itself (see DEFAULT_TTL in
    // invite-links.ts). Sweep expired rows while we're here so the table stays small.
    const token = randomToken();
    const now = Date.now();
    this.sql.exec("DELETE FROM invite_link WHERE expires_at < ?", now);
    this.sql.exec(
      "INSERT INTO invite_link (token, join_url, slack_user_id, expires_at) VALUES (?, ?, ?, ?)",
      token,
      joinUrl,
      input.slackUserId,
      now + INVITE_LINK_TTL_MS,
    );

    log.info("coworking.member_link", { user: input.slackUserId });
    return { token };
  }

  /** Resolve a `/join/<token>` redirect to its personal Zoom url, or null if unknown/expired. */
  async resolveJoinToken(token: string): Promise<{ joinUrl: string } | null> {
    const row = this.sql
      .exec<{ join_url: string }>(
        "SELECT join_url FROM invite_link WHERE token = ? AND expires_at >= ?",
        token,
        Date.now(),
      )
      .toArray()[0];
    log.info("coworking.join.resolve", { found: Boolean(row) }); // never log the token or url
    return row ? { joinUrl: row.join_url } : null;
  }

  /**
   * Admin (`/vc-bot-admin coworking open`) announce-only: post a plain room-open message — the
   * Join button still works, but there's no tracked session, so this never
   * collides with the Zoom-driven flow. Remembers the message ts so `close` can update it.
   */
  async adminAnnounceOpen(): Promise<void> {
    const res = await createSlackClient(this.env).chat.postMessage({
      channel: this.env.SLACK_COWORKING_CHANNEL_ID,
      text: roomOpenText(this.env),
      blocks: buildRoomOpenBlocks(this.env, []),
    });
    if (res.ts) await this.ctx.storage.put(ADMIN_ANNOUNCEMENT_KEY, res.ts);
    log.info("coworking.admin_announce", { action: "open", ts: res.ts });
  }

  /** Admin (`/vc-bot-admin coworking close`): update the last announce-only message to ended. */
  async adminAnnounceClose(): Promise<{ closed: boolean }> {
    const ts = await this.ctx.storage.get<string>(ADMIN_ANNOUNCEMENT_KEY);
    if (!ts) return { closed: false };
    // Either way the pointer is spent: a vanished announcement counts as "nothing to close".
    const closed = await this.tryUpdateRoomMessage(ts, roomClosedText(this.env), [
      { type: "section", text: { type: "mrkdwn", text: roomClosedText(this.env) } },
    ]);
    await this.ctx.storage.delete(ADMIN_ANNOUNCEMENT_KEY);
    log.info("coworking.admin_announce", { action: "close", closed });
    return { closed };
  }

  async handleZoomEvent(event: ZoomMeetingEvent): Promise<void> {
    switch (event.event) {
      case "meeting.started":
        return this.onMeetingStarted(event);
      case "meeting.ended":
        return this.onMeetingEnded(event);
      case "meeting.participant_joined":
        return this.onParticipantJoined(event);
      case "meeting.participant_left":
        return this.onParticipantLeft(event);
    }
  }

  /** Stale-session safety net: force-end any session still active hours after it started. */
  override async alarm(): Promise<void> {
    const active = this.sql
      .exec<SessionRow>("SELECT * FROM session WHERE status = 'active'")
      .toArray();
    log.warn("coworking.alarm", { staleSessions: active.length });
    for (const session of active) {
      await this.closeSession(session, Date.now());
    }
  }

  // --- Event handlers ---

  private async onMeetingStarted(event: ZoomMeetingEvent): Promise<void> {
    const uuid = instanceUuid(event);
    if (this.getSession(uuid)?.status === "active") return; // duplicate webhook (same uuid)

    const startedAt = eventTimeMs(event);

    // A different instance is still marked active — its meeting.ended never arrived (e.g. the
    // worker wasn't reachable). One Zoom meeting ID has at most one live instance, and duplicate
    // start webhooks reuse the same uuid (deduped above), so a start with a NEW uuid proves the
    // old session is dead. Close it now (stats summary) instead of leaving the room wedged until
    // the 18h stale-session alarm; its CTA is retired below like any other previous session's.
    const staleSessions = this.sql
      .exec<SessionRow>("SELECT * FROM session WHERE status = 'active'")
      .toArray();
    for (const stale of staleSessions) {
      log.warn("coworking.started.closing_stale", { stale: stale.instance_uuid, instance: uuid });
      await this.closeSession(stale, startedAt);
    }

    const client = createSlackClient(this.env);

    // Always a NEW message, never an edit of the previous session's card: a fresh post is what
    // makes Slack notify the channel that the room just opened (an edit is silent).
    log.debug("coworking.started.post", { instance: uuid });
    const res = await client.chat.postMessage({
      channel: this.env.SLACK_COWORKING_CHANNEL_ID,
      text: roomOpenText(this.env),
      blocks: buildRoomOpenBlocks(this.env, [], startedAt),
    });
    const messageTs = res.ts ?? null;
    if (!res.ts) log.warn("coworking.room_msg.no_ts", { instance: uuid });

    log.debug("coworking.started.session_row", { instance: uuid });
    this.sql.exec(
      `INSERT INTO session (instance_uuid, slack_message_ts, started_at, status)
       VALUES (?, ?, ?, 'active')
       ON CONFLICT(instance_uuid) DO UPDATE SET
         status = 'active', slack_message_ts = excluded.slack_message_ts,
         started_at = excluded.started_at, ended_at = NULL, peak_participants = 0`,
      uuid,
      messageTs,
      startedAt,
    );

    await this.ctx.storage.setAlarm(Date.now() + STALE_SESSION_MS);
    log.info("coworking.started", { instance: uuid });

    // Retire the previous card's CTA last: after the new message is up (so a failed post never
    // leaves the channel with no way in) and after the session is recorded (so a failure here
    // can't wedge the room by dropping the joins that follow).
    await this.retireLastCta();
  }

  private async onParticipantJoined(event: ZoomMeetingEvent): Promise<void> {
    const uuid = instanceUuid(event);
    const session = this.getSession(uuid);
    if (session?.status !== "active") {
      log.debug("coworking.joined.drop_no_session", { instance: uuid });
      return; // no open session — drop (race-safe)
    }

    const participant = event.payload.object.participant;
    if (!participant) return;
    const id = participantIdentity(participant);
    if (!id.zoomUserId) return;

    log.debug("coworking.join.correlate", { instance: uuid });
    // Best-effort: match the Zoom display name to a member who minted an invite link.
    const member = this.findMember(id.displayName);
    const slackUserId = member?.slack_user_id ?? null;
    const externalId = slackUserId ? null : id.zoomUserId;
    log.debug("coworking.join.correlated", { instance: uuid, as: slackUserId ? "member" : "guest" });

    this.sql.exec(
      `INSERT INTO participant
         (zoom_user_id, instance_uuid, slack_user_id, external_id, display_name, joined_at, left_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(zoom_user_id, instance_uuid) DO UPDATE SET
         display_name = excluded.display_name, slack_user_id = excluded.slack_user_id,
         external_id = excluded.external_id, left_at = NULL`,
      id.zoomUserId,
      uuid,
      slackUserId,
      externalId,
      id.displayName,
      eventTimeMs(event),
    );

    // Track peak concurrent attendance for the end-of-session stats.
    const present = this.countPresent(uuid);
    this.sql.exec(
      "UPDATE session SET peak_participants = MAX(peak_participants, ?) WHERE instance_uuid = ?",
      present,
      uuid,
    );

    await this.updatePresence(session);
    log.info("coworking.joined", { instance: uuid, as: slackUserId ? "member" : "guest" });
  }

  private async onParticipantLeft(event: ZoomMeetingEvent): Promise<void> {
    const uuid = instanceUuid(event);
    const session = this.getSession(uuid);

    const participant = event.payload.object.participant;
    if (!participant) return;
    const id = participantIdentity(participant);

    log.debug("coworking.left.lookup", { instance: uuid });
    const row = this.sql
      .exec<ParticipantRow>(
        "SELECT * FROM participant WHERE zoom_user_id = ? AND instance_uuid = ?",
        id.zoomUserId,
        uuid,
      )
      .toArray()[0];
    if (!row) {
      log.debug("coworking.left.drop_unknown", { instance: uuid });
      return; // unknown or already removed — idempotent
    }

    // Soft-delete: mark them gone but keep the row so the end-of-session roster survives.
    this.sql.exec(
      "UPDATE participant SET left_at = ? WHERE zoom_user_id = ? AND instance_uuid = ?",
      eventTimeMs(event),
      id.zoomUserId,
      uuid,
    );

    if (session) await this.updatePresence(session);
    log.info("coworking.left", { instance: uuid });
  }

  private async onMeetingEnded(event: ZoomMeetingEvent): Promise<void> {
    const session = this.getSession(instanceUuid(event));
    if (session?.status !== "active") return; // already ended / unknown
    await this.closeSession(session, eventTimeMs(event));
  }

  // --- Helpers ---

  /**
   * `chat.update` that treats a vanished target — the message was deleted by hand, or the stored
   * ts was minted against another channel (a stale dev pointer) — as recoverable: warn and return
   * false so the caller can post a fresh message, instead of wedging the room on a dead ts.
   * Any other failure still throws.
   */
  private async tryUpdateRoomMessage(
    ts: string,
    text: string,
    blocks: AnyMessageBlock[],
  ): Promise<boolean> {
    try {
      await createSlackClient(this.env).chat.update({
        channel: this.env.SLACK_COWORKING_CHANNEL_ID,
        ts,
        text,
        blocks,
      });
      return true;
    } catch (err) {
      const code = err instanceof SlackAPIError ? err.error : String(err);
      if (code.includes("message_not_found") || code.includes("channel_not_found")) {
        log.warn("coworking.room_msg.stale_pointer", { ts, error: code });
        return false;
      }
      throw err;
    }
  }

  private async closeSession(session: SessionRow, endedAt: number): Promise<void> {
    if (session.slack_message_ts) {
      const stats: SessionStats = {
        startedAtMs: session.started_at,
        endedAtMs: endedAt,
        durationMs: session.started_at ? Math.max(0, endedAt - session.started_at) : 0,
        peak: session.peak_participants ?? 0,
        attendees: this.buildRoster(session.instance_uuid),
      };
      log.debug("coworking.end.update_msg", { ts: session.slack_message_ts, peak: stats.peak });
      // The stats summary carries the "start a new session" CTA, so this message *is* the standing
      // invite until the next session opens. If the room message was deleted mid-session, the
      // warning is enough — the session must still flip to ended, and there's simply no card left
      // to carry the CTA.
      const updated = await this.tryUpdateRoomMessage(
        session.slack_message_ts,
        roomClosedText(this.env),
        buildRoomClosedBlocks(this.env, stats),
      );
      if (updated) {
        await this.ctx.storage.put<LastClosed>(LAST_CLOSED_KEY, {
          ts: session.slack_message_ts,
          stats,
        });
      }
    }

    this.sql.exec(
      "UPDATE session SET status = 'ended', ended_at = ? WHERE instance_uuid = ?",
      endedAt,
      session.instance_uuid,
    );
    this.sql.exec("DELETE FROM participant WHERE instance_uuid = ?", session.instance_uuid);
    await this.ctx.storage.deleteAlarm();
    log.info("coworking.ended", { instance: session.instance_uuid });
  }

  /**
   * Strip the invite CTA from the previous session's ended card so only one live "start a session"
   * button exists at a time. Re-renders it from the cached stats with `{ invite: false }` — the
   * roster is gone from SQL by now, which is why the stats ride along in storage.
   */
  private async retireLastCta(): Promise<void> {
    const last = await this.ctx.storage.get<LastClosed>(LAST_CLOSED_KEY);
    if (last) {
      log.debug("coworking.cta.retire", { ts: last.ts });
      await this.tryUpdateRoomMessage(
        last.ts,
        roomClosedText(this.env),
        buildRoomClosedBlocks(this.env, last.stats, { invite: false }),
      );
      await this.ctx.storage.delete(LAST_CLOSED_KEY);
    }

    // One-shot cleanup of the retired lifecycle's standing invite: a "the room is quiet" message
    // carries no history worth keeping, so delete it outright rather than leave a live button
    // behind. Best-effort — a failure here must never fail the session start.
    const legacyTs = await this.ctx.storage.get<string>(LEGACY_ROOM_MESSAGE_KEY);
    if (legacyTs) {
      try {
        await createSlackClient(this.env).chat.delete({
          channel: this.env.SLACK_COWORKING_CHANNEL_ID,
          ts: legacyTs,
        });
      } catch (err) {
        log.warn("coworking.legacy_invite.delete_failed", { ts: legacyTs, err: String(err) });
      }
      await this.ctx.storage.delete(LEGACY_ROOM_MESSAGE_KEY);
    }
  }

  /**
   * Re-render the open-room message's presence list from the live `participant` rows. Called after
   * every join/leave; no-op if the session has no posted message to edit.
   */
  private async updatePresence(session: SessionRow): Promise<void> {
    if (!session.slack_message_ts) return;
    const rows = this.sql
      .exec<ParticipantRow>(
        "SELECT * FROM participant WHERE instance_uuid = ? AND left_at IS NULL ORDER BY joined_at",
        session.instance_uuid,
      )
      .toArray();
    const present: PresenceUser[] = rows.map((r) =>
      r.slack_user_id
        ? { slackUserId: r.slack_user_id }
        : { displayName: r.display_name ?? "A guest" },
    );
    log.debug("coworking.presence.update", { instance: session.instance_uuid, count: present.length });
    // A vanished message just warns and skips — a join/leave webhook must never throw over it;
    // closeSession / the next session will re-point the message.
    await this.tryUpdateRoomMessage(
      session.slack_message_ts,
      roomOpenText(this.env),
      buildRoomOpenBlocks(this.env, present, session.started_at),
    );
  }

  /**
   * Deduped roster of everyone who stopped by this session (regardless of whether they're still in
   * the room): members collapsed by slack_user_id, guests by display name. Ordered by first join.
   */
  private buildRoster(uuid: string): PresenceUser[] {
    const rows = this.sql
      .exec<ParticipantRow>(
        "SELECT * FROM participant WHERE instance_uuid = ? ORDER BY joined_at",
        uuid,
      )
      .toArray();
    const seen = new Set<string>();
    const roster: PresenceUser[] = [];
    for (const r of rows) {
      if (r.slack_user_id) {
        const key = `member:${r.slack_user_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        roster.push({ slackUserId: r.slack_user_id });
      } else {
        const name = r.display_name ?? "A guest";
        const key = `guest:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        roster.push({ displayName: name });
      }
    }
    return roster;
  }

  /** Count people currently in the room (joined, not yet left). */
  private countPresent(uuid: string): number {
    return this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM participant WHERE instance_uuid = ? AND left_at IS NULL",
        uuid,
      )
      .toArray()[0]?.n ?? 0;
  }

  /**
   * Best-effort correlation: find the member who minted an invite link with this name. Invite-link
   * joiners carry no registrant id, so the baked-in name is all we have to match on.
   */
  private findMember(name: string): MemberLinkRow | undefined {
    return this.sql
      .exec<MemberLinkRow>(
        "SELECT * FROM member_link WHERE display_name = ? ORDER BY created_at DESC LIMIT 1",
        name,
      )
      .toArray()[0];
  }

  private getSession(uuid: string): SessionRow | undefined {
    return this.sql
      .exec<SessionRow>("SELECT * FROM session WHERE instance_uuid = ?", uuid)
      .toArray()[0];
  }

}
