import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { log, setLogLevel } from "../../log";
import { getCachedZoomToken } from "../../zoom/oauth";
import { createInviteLink } from "../../zoom/invite-links";
import type { ZoomMeetingEvent } from "../../zoom/types";
import {
  type PresenceUser,
  RoomMessage,
  type SessionStats,
  createSlackRoomChannelPort,
} from "./room-message";
import { eventTimeMs, instanceUuid, participantIdentity } from "./zoom-events";

/**
 * Co-working room — one Durable Object instance per Zoom meeting ID. All events for a meeting
 * serialize through this single instance, so the session row is always written before a join
 * is processed (no eventual-consistency race).
 *
 * The DO owns the session state machine (the `session` / `participant` / `member_link` /
 * `invite_link` tables, the stale-session alarm, and the join tokens) and mints per-user Zoom
 * invite links. Everything about the room message — the cards, the copy, the standing-invite
 * hand-off between sessions and announcements — is delegated to `RoomMessage`; the DO only
 * remembers each session's message ts and tells RoomMessage what happened.
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
  private readonly roomMessage: RoomMessage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL); // the DO runs in its own isolate
    this.sql = ctx.storage.sql;
    this.roomMessage = new RoomMessage(createSlackRoomChannelPort(env), ctx.storage, env);
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
   * Admin (`/vc-bot-admin coworking open`): post an announcement — a room message with no
   * session behind it, so it never collides with the Zoom-driven flow.
   */
  async adminAnnounceOpen(): Promise<void> {
    await this.roomMessage.announceOpen();
  }

  /** Admin (`/vc-bot-admin coworking close`): turn the open announcement into an ended card. */
  async adminAnnounceClose(): Promise<{ closed: boolean }> {
    return this.roomMessage.announceClose();
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
    // old session is stale. Close it now (ended card) instead of leaving the room wedged until
    // the 18h stale-session alarm; its standing invite is retired below like any previous card's.
    const staleSessions = this.sql
      .exec<SessionRow>("SELECT * FROM session WHERE status = 'active'")
      .toArray();
    for (const stale of staleSessions) {
      log.warn("coworking.started.closing_stale", { stale: stale.instance_uuid, instance: uuid });
      await this.closeSession(stale, startedAt);
    }

    log.debug("coworking.started.post", { instance: uuid });
    const messageTs = await this.roomMessage.open(startedAt);

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

    // Retire the previous standing invite last: after the new message is up (so a failed post
    // never leaves the channel with no way in) and after the session is recorded (so a failure
    // here can't wedge the room by dropping the joins that follow).
    await this.roomMessage.retirePrevious();
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

  private async closeSession(session: SessionRow, endedAt: number): Promise<void> {
    if (session.slack_message_ts) {
      const stats: SessionStats = {
        startedAtMs: session.started_at,
        endedAtMs: endedAt,
        durationMs: session.started_at ? Math.max(0, endedAt - session.started_at) : 0,
        peak: session.peak_participants ?? 0,
        attendees: this.buildRoster(session.instance_uuid),
      };
      // The ended card carries the standing invite. A vanished card is RoomMessage's problem to
      // shrug at — the session must still flip to ended either way.
      await this.roomMessage.close(session.slack_message_ts, stats);
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
   * Re-render the open card's presence from the live `participant` rows. Called after every
   * join/leave; no-op if the session has no posted message to edit.
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
    await this.roomMessage.showPresence(session.slack_message_ts, present, session.started_at);
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
