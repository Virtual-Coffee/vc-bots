import { DurableObject } from "cloudflare:workers";
import { DateTime } from "luxon";
import type { Env } from "../../env";
import { getGoogleAccessToken } from "../../google/auth";
import { log, setLogLevel } from "../../log";
import { createSlackClient } from "../../slack/client";
import { notifyBotLog } from "../../slack/notify";
import type { ReminderMessage } from "../reminders/blocks";
import { buildCancellationMessage, buildRescheduleMessage } from "../reminders/blocks";
import { createGoogleCalendarSource } from "../reminders/sources/google-calendar";
import { reconcileStartingSoon } from "../reminders/index";
import type { ReminderEvent } from "../reminders/source";
import { reminderRange } from "../reminders/source";

/**
 * Calendar sync — a single singleton Durable Object (addressed elsewhere via
 * `env.CALENDAR_SYNC.getByName("default")`). It serializes Google Calendar push notifications and
 * the daily cron seed through one instance, so a notification's snapshot diff never races the
 * cron's snapshot refresh (same race-free rationale as CoworkingRoom).
 *
 * Two jobs:
 * - **Watch lifecycle** (`ensureWatch` / `stopWatch` / `watchStatus`): register a Calendar
 *   `events/watch` push channel, renew it ~1 day before its 7-day expiry via the DO alarm.
 * - **Notification handling** (`processNotification`): on each push, diff the live weekly window
 *   against the last-known snapshot to detect cancellations / reschedules, post standout notices
 *   to the three event channels, reconcile the scheduled "Starting Soon" queue, then persist the
 *   new snapshot.
 *
 * ⚠️ The watch token (`GOOGLE_WATCH_TOKEN`), address (`GOOGLE_WATCH_ADDRESS`), and Google access
 * tokens are credentials — never log them. The channel id is a random uuid, safe to log.
 */

/** Google's default (and max) TTL for a calendar push channel: 7 days. */
const WATCH_TTL_SECONDS = 604800;
/** Renew (and fire the alarm) this far before expiry so the channel never lapses mid-window. */
const RENEW_BUFFER_MS = 24 * 60 * 60 * 1000;
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const CHANNELS_STOP_URL = "https://www.googleapis.com/calendar/v3/channels/stop";

/** Public watch state returned to the admin panel + tests. Never carries the token. */
export type WatchStatus = {
  active: boolean;
  channelId: string | null;
  expiresAt: number | null;
};

// Type aliases (not interfaces) so they satisfy `exec<T>`'s `Record<string, SqlStorageValue>`.
type ChannelRow = {
  id: string;
  resource_id: string | null;
  expiration_ms: number | null;
  token: string | null;
};

type SnapshotRow = {
  id: string;
  starts_at: string;
  title: string | null;
};

export class CalendarSync extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL); // the DO runs in its own isolate
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel (
        id            TEXT PRIMARY KEY,
        resource_id   TEXT,
        expiration_ms INTEGER,
        token         TEXT
      );
      CREATE TABLE IF NOT EXISTS event_snapshot (
        id         TEXT PRIMARY KEY,
        starts_at  TEXT NOT NULL,
        title      TEXT
      );
    `);
  }

  // --- Watch lifecycle ---

  /**
   * Ensure an active Calendar push channel exists, (re)creating it when missing or near expiry, and
   * arm the renewal alarm. Healthy channels are left in place — just re-arm the alarm. Returns the
   * current status (no token).
   */
  async ensureWatch(): Promise<WatchStatus> {
    const existing = this.getChannel();
    const now = Date.now();

    if (existing && existing.expiration_ms !== null && existing.expiration_ms - RENEW_BUFFER_MS > now) {
      // Still healthy — just keep the renewal alarm armed.
      await this.ctx.storage.setAlarm(existing.expiration_ms - RENEW_BUFFER_MS);
      log.info("calendar_sync.watch_healthy", {
        channelId: existing.id,
        expiresAt: existing.expiration_ms,
      });
      return { active: true, channelId: existing.id, expiresAt: existing.expiration_ms };
    }

    // (Re)create. Stop the old channel best-effort first so Google isn't left double-notifying.
    if (existing) {
      await this.stopChannel(existing.id, existing.resource_id);
    }

    const token = await getGoogleAccessToken(this.env);
    const calendarId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);
    const channelId = crypto.randomUUID();
    const res = await fetch(`${CALENDAR_BASE}/${calendarId}/events/watch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: this.notifyAddress(),
        token: this.env.GOOGLE_WATCH_TOKEN,
        params: { ttl: String(WATCH_TTL_SECONDS) },
      }),
    });
    if (!res.ok) {
      // Google's error body may be useful; the request body (carrying address/token) is not echoed.
      throw new Error(`Google Calendar watch failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json<{ resourceId?: string; expiration?: string }>();
    if (typeof body.resourceId !== "string" || typeof body.expiration !== "string") {
      throw new Error("Google Calendar watch returned an unexpected body shape");
    }
    const expirationMs = Number(body.expiration);

    // Replace the single channel row.
    this.sql.exec("DELETE FROM channel");
    this.sql.exec(
      "INSERT INTO channel (id, resource_id, expiration_ms, token) VALUES (?, ?, ?, ?)",
      channelId,
      body.resourceId,
      expirationMs,
      this.env.GOOGLE_WATCH_TOKEN,
    );

    await this.ctx.storage.setAlarm(expirationMs - RENEW_BUFFER_MS);

    // First-time setup: establish a snapshot baseline so the next notification has something to
    // diff against (otherwise every event would look "new").
    if (this.snapshotEmpty()) {
      await this.seed();
    }

    log.info("calendar_sync.watch_created", { channelId, expiresAt: expirationMs });
    return { active: true, channelId, expiresAt: expirationMs };
  }

  /** Stop the active push channel (if any), drop the row, and disarm the renewal alarm. */
  async stopWatch(): Promise<{ stopped: boolean }> {
    const existing = this.getChannel();
    if (!existing) return { stopped: false };

    await this.stopChannel(existing.id, existing.resource_id);
    this.sql.exec("DELETE FROM channel");
    await this.ctx.storage.deleteAlarm();
    log.info("calendar_sync.watch_stopped", { channelId: existing.id });
    return { stopped: true };
  }

  /** Current watch status (no token). Active = a row exists and isn't past its expiry. */
  async watchStatus(): Promise<WatchStatus> {
    const existing = this.getChannel();
    if (!existing) return { active: false, channelId: null, expiresAt: null };
    const active = existing.expiration_ms !== null && existing.expiration_ms > Date.now();
    return { active, channelId: existing.id, expiresAt: existing.expiration_ms };
  }

  /**
   * Overwrite the snapshot to match the current weekly window — no notices, no reconcile. The
   * baseline the daily cron refreshes so mid-week notifications have something to diff against.
   */
  async seed(nowMs: number = Date.now()): Promise<void> {
    const range = reminderRange("weekly", nowMs);
    const events = await createGoogleCalendarSource(this.env).fetchEvents(range);
    this.writeSnapshot(events);
    log.info("calendar_sync.seeded", { count: events.length });
  }

  /**
   * Core push-notification handler. Diffs the live weekly window against the last snapshot:
   * detects cancellations (left window + the event is gone/cancelled), reschedules
   * (out-of-window moves and in-window time changes), posts standout notices to the three event
   * channels, reconciles the scheduled "Starting Soon" queue for the daily window, then persists
   * the new snapshot. New events get no notice — the scheduling reconcile handles them.
   */
  async processNotification(nowMs: number = Date.now()): Promise<void> {
    const weekly = reminderRange("weekly", nowMs);
    const daily = reminderRange("daily", nowMs);

    const source = createGoogleCalendarSource(this.env);
    const current = await source.fetchEvents(weekly);

    const prior = new Map<string, { startsAt: string; title: string | null }>();
    for (const row of this.sql.exec<SnapshotRow>("SELECT * FROM event_snapshot").toArray()) {
      prior.set(row.id, { startsAt: row.starts_at, title: row.title });
    }
    const currentById = new Map<string, ReminderEvent>();
    for (const e of current) currentById.set(e.id, e);

    // Only announce a change for an event whose announced start is still upcoming. A change to an
    // event that has already begun/passed needs no correction; and because the window is the
    // current Mon–Sun announced week (Change 1), next week's events aren't in the snapshot at all,
    // so they never produce a diff until their own Monday summary goes out.
    const isFuture = (iso: string): boolean =>
      DateTime.fromISO(iso, { setZone: true }).toMillis() > nowMs;

    const notices: ReminderMessage[] = [];
    let cancellations = 0;
    let reschedules = 0;

    // Snapshot ids no longer in the live window: cancelled, or rescheduled out of the window.
    for (const [id, snap] of prior) {
      if (currentById.has(id)) continue;
      if (!isFuture(snap.startsAt)) continue; // already happened — nothing to correct
      const event = await this.getEvent(id);
      if (event === null || event.status === "cancelled") {
        const reconstructed: ReminderEvent = {
          id,
          title: snap.title ?? "(event)",
          startsAt: snap.startsAt,
        };
        notices.push(buildCancellationMessage(reconstructed));
        cancellations += 1;
      } else if (event.start?.dateTime) {
        const newStart =
          DateTime.fromISO(event.start.dateTime, { setZone: true }).toUTC().toISO() ??
          event.start.dateTime;
        const moved: ReminderEvent = { id, title: snap.title ?? "(event)", startsAt: newStart };
        notices.push(buildRescheduleMessage(moved, snap.startsAt));
        reschedules += 1;
      }
      // A live all-day event (start.date only) that left the timed window: no actionable notice.
    }

    // In-window reschedules: present in both, but the start time changed.
    for (const [id, event] of currentById) {
      const snap = prior.get(id);
      if (!snap) continue; // new event — scheduling handles it, no notice
      if (!isFuture(snap.startsAt)) continue; // the announced slot already passed
      if (event.startsAt !== snap.startsAt) {
        notices.push(buildRescheduleMessage(event, snap.startsAt));
        reschedules += 1;
      }
    }

    const client = createSlackClient(this.env);

    // Announce each notice to all three event channels.
    const channels = [
      this.env.SLACK_ANNOUNCEMENTS_CHANNEL_ID,
      this.env.SLACK_EVENTS_CHANNEL_ID,
      this.env.SLACK_EVENTADMIN_CHANNEL_ID,
    ];
    for (const notice of notices) {
      for (const channel of channels) {
        await client.chat.postMessage({
          channel,
          ...notice,
          unfurl_links: false,
          unfurl_media: false,
        });
      }
    }

    // Re-sync the scheduled "Starting Soon" queue for the daily window against the live calendar.
    // Fetch the daily window directly (rather than filtering `current`) so this matches sendDaily
    // exactly — the source bounds the events, avoiding a brittle string compare between UTC `…Z`
    // startsAt and the Eastern-offset range bounds.
    const dailyEvents = await source.fetchEvents(daily);
    await reconcileStartingSoon(client, this.env, dailyEvents, nowMs, daily);

    this.writeSnapshot(current);

    log.info("calendar_sync.processed", {
      cancellations,
      reschedules,
      currentCount: current.length,
    });
  }

  /** Renewal alarm: re-create/renew the watch. Self-swallowing after alerting #bot-log. */
  override async alarm(): Promise<void> {
    try {
      await this.ensureWatch();
    } catch (error) {
      log.error("calendar_sync.alarm_failed", { error: String(error) });
      await notifyBotLog(this.env, "calendar_sync.alarm_failed", { error: String(error) });
    }
  }

  // --- Helpers ---

  /**
   * The public URL Google posts change notifications to — the Worker's `/google/notify` route under
   * `PUBLIC_BASE_URL` (the Netlify rewrite host, which must be domain-verified in Google Cloud
   * Console). There's no inbound request here (cron/alarm), so unlike the join redirect there's no
   * origin fallback: an empty `PUBLIC_BASE_URL` means no watch can be registered.
   */
  private notifyAddress(): string {
    const base = (this.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("PUBLIC_BASE_URL must be set to register a Google Calendar watch");
    }
    return `${base}/google/notify`;
  }

  private getChannel(): ChannelRow | undefined {
    return this.sql.exec<ChannelRow>("SELECT * FROM channel LIMIT 1").toArray()[0];
  }

  private snapshotEmpty(): boolean {
    const row = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_snapshot")
      .toArray()[0];
    return (row?.n ?? 0) === 0;
  }

  /** Replace the whole snapshot with the given events. */
  private writeSnapshot(events: ReminderEvent[]): void {
    this.sql.exec("DELETE FROM event_snapshot");
    for (const e of events) {
      this.sql.exec(
        "INSERT INTO event_snapshot (id, starts_at, title) VALUES (?, ?, ?)",
        e.id,
        e.startsAt,
        e.title,
      );
    }
  }

  /**
   * Fetch a single Calendar event. Returns null on 404/410 (the event is gone), throws on other
   * non-OK responses so a transient API failure surfaces rather than masquerading as a deletion.
   */
  private async getEvent(
    id: string,
  ): Promise<{ status?: string; start?: { dateTime?: string; date?: string } } | null> {
    const token = await getGoogleAccessToken(this.env);
    const calendarId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);
    const res = await fetch(
      `${CALENDAR_BASE}/${calendarId}/events/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) {
      throw new Error(`Google Calendar get event failed: ${res.status} ${await res.text()}`);
    }
    return res.json<{ status?: string; start?: { dateTime?: string; date?: string } }>();
  }

  /** Best-effort stop of a push channel — failures are logged (warn) and ignored. */
  private async stopChannel(id: string, resourceId: string | null): Promise<void> {
    if (!resourceId) return;
    try {
      const token = await getGoogleAccessToken(this.env);
      const res = await fetch(CHANNELS_STOP_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, resourceId }),
      });
      if (!res.ok) {
        log.warn("calendar_sync.stop_channel_failed", { channelId: id, status: res.status });
      }
    } catch (error) {
      log.warn("calendar_sync.stop_channel_failed", { channelId: id, error: String(error) });
    }
  }
}
