import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { log, setLogLevel } from "../../log";
import { SerialQueue } from "../../serial-queue";
import { createZoomInviteLinkPort } from "../../zoom/invite-links";
import type { ZoomMeetingEvent, ZoomParticipant } from "../../zoom/types";
import { type InviteLinks, createInviteLinks } from "./invite-link";
import {
  type PresenceUser,
  RoomMessage,
  type SessionStats,
  createSlackRoomChannelPort,
} from "./room-message";

/**
 * Co-working room — one Durable Object instance per Zoom meeting ID. The instance alone does not
 * serialize its handlers; `enqueue` does (ADR 0003).
 *
 * The DO owns the session state machine (the `session` / `participant` tables and the stale-session
 * alarm) and creates the `member_link` / `invite_link` tables; the invite links themselves —
 * Zoom mint, join tokens, TTL, urls — belong to `InviteLinks` (`invite-link.ts`). Everything
 * about the room message — the cards, the copy, the standing-invite hand-off between sessions and
 * announcements, which card is open — is delegated to `RoomMessage`; the DO never sees a message
 * ts, it only tells RoomMessage what happened. Both are swappable fields so the DO suite runs
 * against in-memory fakes.
 */

/** Force-end a session this long after it started if `meeting.ended` was never received. */
const STALE_SESSION_MS = 18 * 60 * 60 * 1000;

/**
 * Storage key of the joins that reached the DO before their instance's `meeting.started` — Zoom
 * sends the pair milliseconds apart, and the join can win the race to the queue (ADR 0003).
 */
const PENDING_JOINS_KEY = "pending_joins";

/** How long a buffered join waits for its `meeting.started` before it's dropped. */
const PENDING_JOIN_TTL_MS = 30 * 1000;

// Type aliases (not interfaces) so they satisfy `exec<T>`'s `Record<string, SqlStorageValue>`.
type SessionRow = {
  instance_uuid: string;
  started_at: number | null;
  ended_at: number | null;
  status: string;
  peak_participants: number | null;
};

type PendingJoin = { uuid: string; event: ZoomMeetingEvent; at: number };

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
  // Not readonly: tests swap in fakes (`installInviteLinkFake` / `installRoomChannelFake`).
  private inviteLinks: InviteLinks;
  private roomMessage: RoomMessage;
  /** Serializes the state-mutating handlers — see `enqueue`. */
  private readonly queue = new SerialQueue("coworking.queue");

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL); // the DO runs in its own isolate
    this.sql = ctx.storage.sql;
    this.inviteLinks = createInviteLinks(this.sql, createZoomInviteLinkPort(env, ctx.storage), env);
    this.roomMessage = new RoomMessage(createSlackRoomChannelPort(env), ctx.storage, env);
    // The runtime holds deliveries until this settles; nothing to await in a constructor.
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private async migrate(): Promise<void> {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session (
        instance_uuid     TEXT PRIMARY KEY,
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

    // One-shot: the open card's ts used to live on the session row; RoomMessage keeps it now
    // (`room_message:open`). Hand a live session's card over before dropping the column, so a
    // deploy mid-session keeps editing the right message. Can go once every DO has booted past it.
    if (this.hasColumn("session", "slack_message_ts")) {
      const open = this.sql
        .exec<{ slack_message_ts: string; started_at: number | null }>(
          `SELECT slack_message_ts, started_at FROM session
           WHERE status = 'active' AND slack_message_ts IS NOT NULL
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .toArray()[0];
      if (open) {
        await this.roomMessage.adoptOpenCard(open.slack_message_ts, open.started_at ?? Date.now());
      }
      this.sql.exec("ALTER TABLE session DROP COLUMN slack_message_ts");
      log.info("coworking.migrate.drop_message_ts", { adopted: Boolean(open) });
    }
  }

  /** Add a column only if it's not already present (idempotent schema migration). */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((c) => c.name === column);
  }

  /** Work items queued or running — readable via `runInDurableObject` so tests can prove interleaving. */
  get queueDepth(): number {
    return this.queue.depth;
  }

  /**
   * Run `work` after every previously queued piece of work has finished (ADR 0003). The tail
   * never rejects, so one failing handler can't wedge the room; the caller still sees its own failure.
   * `label` names the work in the queue logs — `coworking.queue.wait` at `info` is the signal that
   * the interleaving the queue exists for actually happened.
   */
  private enqueue<T>(label: string, work: () => Promise<T>): Promise<T> {
    return this.queue.run(label, work);
  }

  // --- RPC surface ---

  /**
   * Slack Join click → mint a per-user Zoom invite link (name pre-filled) and return the Worker's
   * `/join/<token>` url for it. The raw `join_url` and the token stay inside the DO's invite-link
   * store: the join button points at the redirect, which calls `resolveJoinToken` — so the
   * token-bearing Zoom url appears nowhere in the Slack UI (and, as ever, nowhere in logs).
   *
   * Correlation is best-effort by display name — see `InviteLinks`. `displayName` is null when
   * the caller couldn't read the member's Slack profile.
   */
  async handleJoinRequest(input: {
    slackUserId: string;
    displayName: string | null;
  }): Promise<{ joinUrl: string }> {
    return this.inviteLinks.request(input);
  }

  /** Resolve a `/join/<token>` redirect to its personal Zoom url, or null if unknown/expired. */
  resolveJoinToken(token: string): { joinUrl: string } | null {
    return this.inviteLinks.resolve(token);
  }

  /**
   * Admin (`/vc-bot-admin coworking open`): post an announcement — a room message with no
   * session behind it, so it never collides with the Zoom-driven flow.
   */
  async adminAnnounceOpen(): Promise<void> {
    await this.enqueue("admin.announce_open", () => this.roomMessage.announceOpen());
  }

  /** Admin (`/vc-bot-admin coworking close`): turn the open announcement into an ended card. */
  async adminAnnounceClose(): Promise<{ closed: boolean }> {
    return this.enqueue("admin.announce_close", () => this.roomMessage.announceClose());
  }

  async handleZoomEvent(event: ZoomMeetingEvent): Promise<void> {
    return this.enqueue(event.event, () => {
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
    });
  }

  /** Stale-session safety net: force-end any session still active hours after it started. */
  override async alarm(): Promise<void> {
    await this.enqueue("alarm", async () => {
      const active = this.sql
        .exec<SessionRow>("SELECT * FROM session WHERE status = 'active'")
        .toArray();
      log.warn("coworking.alarm", { staleSessions: active.length });
      for (const session of active) {
        await this.closeSession(session, Date.now());
      }
    });
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
    // the 18h stale-session alarm; its standing invite is retired by `open` like any previous card's.
    const staleSessions = this.sql
      .exec<SessionRow>("SELECT * FROM session WHERE status = 'active'")
      .toArray();
    for (const stale of staleSessions) {
      log.warn("coworking.started.closing_stale", { stale: stale.instance_uuid, instance: uuid });
      await this.closeSession(stale, startedAt);
    }

    log.debug("coworking.started.post", { instance: uuid });
    await this.roomMessage.open(startedAt);

    log.debug("coworking.started.session_row", { instance: uuid });
    this.sql.exec(
      `INSERT INTO session (instance_uuid, started_at, status)
       VALUES (?, ?, 'active')
       ON CONFLICT(instance_uuid) DO UPDATE SET
         status = 'active', started_at = excluded.started_at, ended_at = NULL,
         peak_participants = 0`,
      uuid,
      startedAt,
    );

    await this.ctx.storage.setAlarm(Date.now() + STALE_SESSION_MS);
    log.info("coworking.started", { instance: uuid });

    await this.replayPendingJoins(uuid);
  }

  private async onParticipantJoined(event: ZoomMeetingEvent): Promise<void> {
    const uuid = instanceUuid(event);
    const session = this.getSession(uuid);
    if (!session) {
      // Not started yet — hold the join until `meeting.started` replays it.
      const pending = await this.loadPendingJoins();
      pending.push({ uuid, event, at: Date.now() });
      await this.savePendingJoins(pending);
      log.info("coworking.joined.buffered", { instance: uuid });
      return;
    }
    if (session.status !== "active") {
      log.warn("coworking.joined.drop_no_session", { instance: uuid });
      return; // the instance already ended — a straggler, nothing to replay it into
    }

    if (this.recordJoin(event)) await this.updatePresence(session);
  }

  /**
   * Store one join against its (active) session and bump the peak. Presence is left to the
   * caller, so a replay of several buffered joins re-renders the card once. False when the event
   * carries no usable participant.
   */
  private recordJoin(event: ZoomMeetingEvent): boolean {
    const uuid = instanceUuid(event);
    const participant = event.payload.object.participant;
    if (!participant) return false;
    const id = participantIdentity(participant);
    if (!id.zoomUserId) {
      log.debug("coworking.joined.drop_no_id", { instance: uuid });
      return false;
    }

    log.debug("coworking.join.correlate", { instance: uuid });
    // Best-effort: match the Zoom display name to a member who minted an invite link.
    const slackUserId = this.inviteLinks.findMember(id.displayName);
    const externalId = slackUserId ? null : id.zoomUserId;
    log.debug("coworking.join.correlated", {
      instance: uuid,
      as: slackUserId ? "member" : "guest",
    });

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

    log.info("coworking.joined", { instance: uuid, as: slackUserId ? "member" : "guest" });
    return true;
  }

  private async onParticipantLeft(event: ZoomMeetingEvent): Promise<void> {
    const uuid = instanceUuid(event);
    const session = this.getSession(uuid);

    const participant = event.payload.object.participant;
    if (!participant) return;
    const id = participantIdentity(participant);

    if (!session) {
      // In and out before `meeting.started`: cancel the buffered join so the replay skips them.
      const pending = await this.loadPendingJoins();
      const kept = pending.filter((p) => !(p.uuid === uuid && joinIdentity(p) === id.zoomUserId));
      await this.savePendingJoins(kept);
      log.info("coworking.left.buffered_cancel", {
        instance: uuid,
        cancelled: pending.length - kept.length,
      });
      return;
    }

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

    await this.updatePresence(session);
    log.info("coworking.left", { instance: uuid });
  }

  private async onMeetingEnded(event: ZoomMeetingEvent): Promise<void> {
    const session = this.getSession(instanceUuid(event));
    if (session?.status !== "active") return; // already ended / unknown
    await this.closeSession(session, eventTimeMs(event));
  }

  // --- Helpers ---

  /**
   * Record this instance's buffered joins now that its session row exists, and only then drop
   * them from the buffer — a throw mid-replay leaves them to expire with a warn, not vanish.
   */
  private async replayPendingJoins(uuid: string): Promise<void> {
    const pending = await this.loadPendingJoins();
    const mine = pending.filter((p) => p.uuid === uuid);

    let recorded = 0;
    for (const p of mine) if (this.recordJoin(p.event)) recorded++;
    await this.savePendingJoins(pending.filter((p) => p.uuid !== uuid)); // also persists the prune
    if (mine.length === 0) return;

    const session = this.getSession(uuid);
    if (recorded > 0 && session) await this.updatePresence(session);
    log.info("coworking.joined.replayed", { instance: uuid, count: recorded });
  }

  /**
   * The buffered joins still inside their TTL. Expired ones are data loss — their instance never
   * started — so each warns; the caller's save drops them from storage.
   */
  private async loadPendingJoins(): Promise<PendingJoin[]> {
    const all = (await this.ctx.storage.get<PendingJoin[]>(PENDING_JOINS_KEY)) ?? [];
    const cutoff = Date.now() - PENDING_JOIN_TTL_MS;
    for (const p of all) {
      if (p.at < cutoff) log.warn("coworking.joined.buffer_expired", { instance: p.uuid });
    }
    return all.filter((p) => p.at >= cutoff);
  }

  private async savePendingJoins(pending: PendingJoin[]): Promise<void> {
    if (pending.length > 0) await this.ctx.storage.put(PENDING_JOINS_KEY, pending);
    else await this.ctx.storage.delete(PENDING_JOINS_KEY);
  }

  private async closeSession(session: SessionRow, endedAt: number): Promise<void> {
    const stats: SessionStats = {
      startedAtMs: session.started_at,
      endedAtMs: endedAt,
      durationMs: session.started_at ? Math.max(0, endedAt - session.started_at) : 0,
      peak: session.peak_participants ?? 0,
      attendees: this.buildRoster(session.instance_uuid),
    };
    // The ended card carries the standing invite. A vanished card is RoomMessage's problem to
    // shrug at — the session must still flip to ended either way.
    await this.roomMessage.close(stats);

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
   * join/leave; RoomMessage skips it when there's no open card to edit.
   */
  private async updatePresence(session: SessionRow): Promise<void> {
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
    await this.roomMessage.showPresence(present);
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
    return (
      this.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM participant WHERE instance_uuid = ? AND left_at IS NULL",
          uuid,
        )
        .toArray()[0]?.n ?? 0
    );
  }

  private getSession(uuid: string): SessionRow | undefined {
    return this.sql
      .exec<SessionRow>("SELECT * FROM session WHERE instance_uuid = ?", uuid)
      .toArray()[0];
  }
}

// --- Zoom event helpers ---

interface ParticipantIdentity {
  /** Per-meeting id used to match a later participant_left to this join. */
  zoomUserId: string;
  displayName: string;
}

function instanceUuid(event: ZoomMeetingEvent): string {
  return event.payload.object.uuid;
}

/** Event timestamp in ms — prefer Zoom's `event_ts`, fall back to wall clock. */
function eventTimeMs(event: ZoomMeetingEvent): number {
  return typeof event.event_ts === "number" ? event.event_ts : Date.now();
}

/** The zoom user id a buffered join was for ("" when it carried no participant). */
function joinIdentity(p: PendingJoin): string {
  const participant = p.event.payload.object.participant;
  return participant ? participantIdentity(participant).zoomUserId : "";
}

function participantIdentity(p: ZoomParticipant): ParticipantIdentity {
  // user_id is the per-meeting handle Zoom reuses across this participant's join/leave pair.
  // participant_uuid is the most reliable fallback if user_id is absent.
  const zoomUserId = p.user_id || p.participant_uuid || p.participant_user_id || "";
  return {
    zoomUserId,
    displayName: p.user_name?.trim() || "A guest",
  };
}
