import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { log, setLogLevel } from "../../log";
import { createSlackClient } from "../../slack/client";
import { getCachedZoomToken } from "../../zoom/oauth";
import { addMeetingRegistrant } from "../../zoom/registrants";
import type { ZoomMeetingEvent } from "../../zoom/types";
import {
  type CallUser,
  buildRoomOpenBlocks,
  callsAdd,
  callsEnd,
  callsParticipantsAdd,
  callsParticipantsRemove,
  toCallUser,
} from "./slack-call";
import {
  type ParticipantIdentity,
  eventTimeMs,
  instanceUuid,
  meetingId,
  participantIdentity,
  roomClosedText,
  roomOpenText,
} from "./zoom-events";

/**
 * Co-working room — one Durable Object instance per Zoom meeting ID. All events for a meeting
 * serialize through this single instance, so the session row is always written before a join
 * is processed (no eventual-consistency race).
 *
 * Renders a live Slack Call in the channel, mints per-user Zoom registrant links, and keeps
 * the Call's participant list in sync as people join/leave.
 */

/** Force-end a session this long after it started if `meeting.ended` was never received. */
const STALE_SESSION_MS = 6 * 60 * 60 * 1000;

/** DO storage key for the ts of an admin-posted (announce-only) room message. */
const ADMIN_ANNOUNCEMENT_KEY = "admin_announcement_ts";

// Type aliases (not interfaces) so they satisfy `exec<T>`'s `Record<string, SqlStorageValue>`.
type SessionRow = {
  instance_uuid: string;
  slack_call_id: string | null;
  slack_message_ts: string | null;
  zoom_meeting_id: string;
  started_at: number | null;
  ended_at: number | null;
  status: string;
};

type RegistrantRow = {
  registrant_id: string;
  instance_uuid: string | null;
  slack_user_id: string | null;
  email: string | null;
  display_name: string | null;
  created_at: number | null;
};

type ParticipantRow = {
  zoom_user_id: string;
  instance_uuid: string;
  registrant_id: string | null;
  slack_user_id: string | null;
  external_id: string | null;
  display_name: string | null;
  joined_at: number | null;
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
        slack_call_id     TEXT,
        slack_message_ts  TEXT,
        zoom_meeting_id   TEXT NOT NULL,
        started_at        INTEGER,
        ended_at          INTEGER,
        status            TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registrant (
        registrant_id   TEXT PRIMARY KEY,
        instance_uuid   TEXT,
        slack_user_id   TEXT,
        email           TEXT,
        display_name    TEXT,
        created_at      INTEGER
      );
      CREATE TABLE IF NOT EXISTS participant (
        zoom_user_id    TEXT,
        instance_uuid   TEXT,
        registrant_id   TEXT,
        slack_user_id   TEXT,
        external_id     TEXT,
        display_name    TEXT,
        joined_at       INTEGER,
        PRIMARY KEY (zoom_user_id, instance_uuid)
      );
    `);
  }

  // --- RPC surface ---

  /**
   * Slack Join click → register the member with Zoom and return their per-user join link.
   * Records `registrant_id ↔ slack_user_id` up front so later correlation is reliable.
   */
  async handleJoinRequest(input: {
    slackUserId: string;
    email?: string;
    displayName: string;
  }): Promise<{ joinUrl: string }> {
    // No email → can't mint a registrant link; hand back the generic invite.
    if (!input.email) {
      log.debug("coworking.join.no_email", { user: input.slackUserId });
      return { joinUrl: this.env.ZOOM_MEETING_INVITE_URL };
    }

    log.debug("coworking.join.token", { user: input.slackUserId });
    const token = await getCachedZoomToken(this.env, this.ctx.storage);
    log.debug("coworking.join.registrant", { user: input.slackUserId });
    const registrant = await addMeetingRegistrant(token, this.env.ZOOM_MEETING_ID, {
      email: input.email,
      firstName: input.displayName,
    });

    log.debug("coworking.join.store", { user: input.slackUserId, registrant: registrant.registrant_id });
    const active = this.getActiveSession();
    this.sql.exec(
      `INSERT INTO registrant (registrant_id, instance_uuid, slack_user_id, email, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(registrant_id) DO UPDATE SET
         slack_user_id = excluded.slack_user_id, email = excluded.email,
         display_name = excluded.display_name, instance_uuid = excluded.instance_uuid`,
      registrant.registrant_id,
      active?.instance_uuid ?? null,
      input.slackUserId,
      input.email,
      input.displayName,
      Date.now(),
    );

    log.info("coworking.registrant", { user: input.slackUserId, registrant: registrant.registrant_id });
    return { joinUrl: registrant.join_url };
  }

  /**
   * Admin (`/vc-bot-admin coworking open`) announce-only: post a plain room-open message — the
   * Join button still works, but there's no Slack Call or tracked session, so this never
   * collides with the Zoom-driven flow. Remembers the message ts so `close` can update it.
   */
  async adminAnnounceOpen(): Promise<void> {
    const res = await createSlackClient(this.env).chat.postMessage({
      channel: this.env.SLACK_COWORKING_CHANNEL_ID,
      text: roomOpenText(this.env),
      blocks: buildRoomOpenBlocks(this.env),
    });
    if (res.ts) await this.ctx.storage.put(ADMIN_ANNOUNCEMENT_KEY, res.ts);
    log.info("coworking.admin_announce", { action: "open", ts: res.ts });
  }

  /** Admin (`/vc-bot-admin coworking close`): update the last announce-only message to ended. */
  async adminAnnounceClose(): Promise<{ closed: boolean }> {
    const ts = await this.ctx.storage.get<string>(ADMIN_ANNOUNCEMENT_KEY);
    if (!ts) return { closed: false };
    await createSlackClient(this.env).chat.update({
      channel: this.env.SLACK_COWORKING_CHANNEL_ID,
      ts,
      text: roomClosedText(this.env),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: roomClosedText(this.env) } }],
    });
    await this.ctx.storage.delete(ADMIN_ANNOUNCEMENT_KEY);
    log.info("coworking.admin_announce", { action: "close" });
    return { closed: true };
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
    if (this.getSession(uuid)?.status === "active") return; // duplicate webhook

    const startedAt = eventTimeMs(event);
    const client = createSlackClient(this.env);

    let callId: string | undefined;
    try {
      log.debug("coworking.started.calls_add", { instance: uuid });
      callId = await callsAdd(client, {
        externalUniqueId: uuid,
        joinUrl: this.env.ZOOM_MEETING_INVITE_URL,
        title: this.env.ROOM_TITLE,
        createdBy: this.env.SLACK_BOT_USER_ID,
        dateStartSec: Math.floor(startedAt / 1000),
      });
      log.debug("coworking.started.call_created", { instance: uuid, call: callId });
    } catch (err) {
      // Calls unavailable — fall back to a plain announcement (parity) without the widget.
      log.error("coworking.calls_add_failed", { instance: uuid, err: String(err) });
    }

    log.debug("coworking.started.post", { instance: uuid, call: callId ?? null });
    const res = await client.chat.postMessage({
      channel: this.env.SLACK_COWORKING_CHANNEL_ID,
      text: roomOpenText(this.env),
      blocks: buildRoomOpenBlocks(this.env, callId),
    });

    log.debug("coworking.started.session_row", { instance: uuid });
    this.sql.exec(
      `INSERT INTO session (instance_uuid, zoom_meeting_id, slack_call_id, slack_message_ts, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'active')
       ON CONFLICT(instance_uuid) DO UPDATE SET
         status = 'active', slack_call_id = excluded.slack_call_id,
         slack_message_ts = excluded.slack_message_ts, started_at = excluded.started_at,
         ended_at = NULL`,
      uuid,
      meetingId(event),
      callId ?? null,
      res.ts ?? null,
      startedAt,
    );

    // Attach any registrants created before the session started to this instance.
    this.sql.exec("UPDATE registrant SET instance_uuid = ? WHERE instance_uuid IS NULL", uuid);

    await this.ctx.storage.setAlarm(Date.now() + STALE_SESSION_MS);
    log.info("coworking.started", { instance: uuid, call: callId ?? null });
  }

  private async onParticipantJoined(event: ZoomMeetingEvent): Promise<void> {
    const uuid = instanceUuid(event);
    const session = this.getSession(uuid);
    if (session?.status !== "active") return; // no open session — drop (race-safe)

    const participant = event.payload.object.participant;
    if (!participant) return;
    const id = participantIdentity(participant);
    if (!id.zoomUserId) return;

    log.debug("coworking.join.correlate", { instance: uuid, registrantId: id.registrantId ?? null });
    const registrant = this.findRegistrant(id);
    const callUser = toCallUser(registrant, id);
    log.debug("coworking.join.correlated", {
      instance: uuid,
      as: "slack_id" in callUser ? "member" : "guest",
    });

    const alreadyHere =
      this.sql
        .exec(
          "SELECT 1 FROM participant WHERE zoom_user_id = ? AND instance_uuid = ?",
          id.zoomUserId,
          uuid,
        )
        .toArray().length > 0;

    this.sql.exec(
      `INSERT INTO participant
         (zoom_user_id, instance_uuid, registrant_id, slack_user_id, external_id, display_name, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(zoom_user_id, instance_uuid) DO UPDATE SET
         display_name = excluded.display_name, slack_user_id = excluded.slack_user_id,
         external_id = excluded.external_id, registrant_id = excluded.registrant_id`,
      id.zoomUserId,
      uuid,
      registrant?.registrant_id ?? id.registrantId ?? null,
      "slack_id" in callUser ? callUser.slack_id : null,
      "external_id" in callUser ? callUser.external_id : null,
      id.displayName,
      eventTimeMs(event),
    );

    if (!alreadyHere && session.slack_call_id) {
      log.debug("coworking.join.calls_add", { instance: uuid, call: session.slack_call_id });
      await callsParticipantsAdd(createSlackClient(this.env), session.slack_call_id, [callUser]);
    }
    log.info("coworking.joined", {
      instance: uuid,
      as: "slack_id" in callUser ? "member" : "guest",
      duplicate: alreadyHere,
    });
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
    if (!row) return; // unknown or already removed — idempotent

    this.sql.exec(
      "DELETE FROM participant WHERE zoom_user_id = ? AND instance_uuid = ?",
      id.zoomUserId,
      uuid,
    );

    if (session?.slack_call_id) {
      const callUser: CallUser = row.slack_user_id
        ? { slack_id: row.slack_user_id }
        : { external_id: row.external_id ?? id.zoomUserId, display_name: row.display_name ?? id.displayName };
      log.debug("coworking.left.calls_remove", { instance: uuid, call: session.slack_call_id });
      await callsParticipantsRemove(createSlackClient(this.env), session.slack_call_id, [callUser]);
    }
    log.info("coworking.left", { instance: uuid });
  }

  private async onMeetingEnded(event: ZoomMeetingEvent): Promise<void> {
    const session = this.getSession(instanceUuid(event));
    if (session?.status !== "active") return; // already ended / unknown
    await this.closeSession(session, eventTimeMs(event));
  }

  // --- Helpers ---

  private async closeSession(session: SessionRow, endedAt: number): Promise<void> {
    const client = createSlackClient(this.env);

    if (session.slack_call_id) {
      log.debug("coworking.end.calls_end", { call: session.slack_call_id });
      await callsEnd(client, session.slack_call_id).catch((err) =>
        log.error("coworking.calls_end_failed", { call: session.slack_call_id, err: String(err) }),
      );
    }
    if (session.slack_message_ts) {
      log.debug("coworking.end.update_msg", { ts: session.slack_message_ts });
      await client.chat.update({
        channel: this.env.SLACK_COWORKING_CHANNEL_ID,
        ts: session.slack_message_ts,
        text: roomClosedText(this.env),
        blocks: [{ type: "section", text: { type: "mrkdwn", text: roomClosedText(this.env) } }],
      });
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

  /** Correlate a participant to a registrant: by `registrant_id` first, then email. */
  private findRegistrant(id: ParticipantIdentity): RegistrantRow | undefined {
    if (id.registrantId) {
      const byId = this.sql
        .exec<RegistrantRow>("SELECT * FROM registrant WHERE registrant_id = ?", id.registrantId)
        .toArray()[0];
      if (byId) return byId;
    }
    if (id.email) {
      return this.sql
        .exec<RegistrantRow>("SELECT * FROM registrant WHERE email = ? LIMIT 1", id.email)
        .toArray()[0];
    }
    return undefined;
  }

  private getSession(uuid: string): SessionRow | undefined {
    return this.sql
      .exec<SessionRow>("SELECT * FROM session WHERE instance_uuid = ?", uuid)
      .toArray()[0];
  }

  private getActiveSession(): SessionRow | undefined {
    return this.sql
      .exec<SessionRow>(
        "SELECT * FROM session WHERE status = 'active' ORDER BY started_at DESC LIMIT 1",
      )
      .toArray()[0];
  }
}
