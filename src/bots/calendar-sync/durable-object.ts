import { DurableObject } from "cloudflare:workers";
import { DateTime } from "luxon";
import type { Env } from "../../env";
import type { ReminderEvent } from "../../events";
import type { CalendarPort } from "../../google/calendar";
import { createGoogleCalendarPort } from "../../google/calendar";
import { log, setLogLevel } from "../../log";
import { createSlackClient } from "../../slack/client";
import { notifyBotLog } from "../../slack/notify";
import type { ReminderMessage } from "../reminders/blocks";
import { buildCancellationMessage, buildRescheduleMessage } from "../reminders/blocks";
import { reconcileStartingSoon } from "../reminders/starting-soon";
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
 * - **Notification handling** (`notify` → `processNotification`): on each push, diff the live
 *   weekly window against the last-known snapshot to detect cancellations / reschedules, persist
 *   the new snapshot, then post standout notices to the three event channels and reconcile the
 *   scheduled "Starting Soon" queue. The snapshot is committed *before* delivery so a failed Slack
 *   call loses (and alerts on) a notice rather than re-posting it to every channel on the next
 *   push. `notify` drops pushes whose channel id isn't the stored one (stale/replaced channels).
 *
 * All Google Calendar traffic goes through the injected `CalendarPort` (`this.calendar`, the
 * real adapter from `src/google/calendar.ts` in production, a fake in tests) — this class knows
 * nothing about the wire shapes.
 *
 * ⚠️ The watch token (`GOOGLE_WATCH_TOKEN`) and address are credentials — never log them. The
 * channel id is a random uuid, safe to log.
 */

/** Renew (and fire the alarm) this far before expiry so the channel never lapses mid-window. */
const RENEW_BUFFER_MS = 24 * 60 * 60 * 1000;
/** When a renewal fails, try again this much later (well inside the 24h buffer). */
const RENEW_RETRY_MS = 60 * 60 * 1000;

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
  // Not readonly: tests swap in a fake (`installCalendarFake`).
  private calendar: CalendarPort;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL); // the DO runs in its own isolate
    this.sql = ctx.storage.sql;
    this.calendar = createGoogleCalendarPort(env);
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

    // (Re)create. The replacement is created and persisted BEFORE the old channel is stopped, so
    // a failure here leaves the old (still-registered) channel and its row intact.
    const { channelId, resourceId, expirationMs } = await this.calendar.watch(
      this.notifyAddress(),
    );

    // Replace the single channel row.
    this.sql.exec("DELETE FROM channel");
    this.sql.exec(
      "INSERT INTO channel (id, resource_id, expiration_ms, token) VALUES (?, ?, ?, ?)",
      channelId,
      resourceId,
      expirationMs,
      this.env.GOOGLE_WATCH_TOKEN,
    );

    await this.ctx.storage.setAlarm(expirationMs - RENEW_BUFFER_MS);

    // Now retire the old channel best-effort. A stop that fails is harmless: `notify` ignores
    // pushes from any channel id other than the one just stored.
    if (existing) {
      await this.calendar.stopChannel(existing.id, existing.resource_id);
    }

    // First-time setup: establish a snapshot baseline so the next notification has something to
    // diff against (otherwise every event would look "new").
    if (this.snapshotEmpty()) {
      await this.seed();
    }

    log.info("calendar_sync.watch_created", { channelId, expiresAt: expirationMs });
    return { active: true, channelId, expiresAt: expirationMs };
  }

  /**
   * Stop the active push channel (if any), drop the row, and disarm the renewal alarm. If Google
   * refuses the stop, the row and alarm are kept and this throws — the watch is still live, and
   * reporting "stopped" would leave a channel pushing at us with no record of it.
   */
  async stopWatch(): Promise<{ stopped: boolean }> {
    const existing = this.getChannel();
    if (!existing) return { stopped: false };

    const result = await this.calendar.stopChannel(existing.id, existing.resource_id);
    if (result === "failed") {
      throw new Error("Google refused to stop the calendar watch channel; the watch is still registered");
    }
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
    const events = await this.calendar.listEvents(range);
    this.writeSnapshot(events);
    log.info("calendar_sync.seeded", { count: events.length });
  }

  /**
   * Entry point for the `/google/notify` route. The route already checked the channel token;
   * this checks the channel *id* against the stored row so a stale channel (one a failed stop
   * left live at Google, or the one just replaced by `ensureWatch`) can't drive a sync.
   */
  async notify(channelId: string, nowMs: number = Date.now()): Promise<void> {
    const existing = this.getChannel();
    if (!existing || existing.id !== channelId) {
      log.warn("calendar_sync.notify_unknown_channel", { channelId });
      return;
    }
    await this.processNotification(nowMs);
  }

  /**
   * Core push-notification handler. Diffs the live weekly window against the last snapshot:
   * detects cancellations (left window + the event is gone/cancelled) and reschedules
   * (out-of-window moves and in-window time changes), persists the new snapshot, then posts
   * standout notices to the three event channels and reconciles the scheduled "Starting Soon"
   * queue for the daily window. New events get no notice — the scheduling reconcile handles them.
   *
   * Delivery failures don't stop the run: each post and the reconcile are isolated, and one
   * aggregate error is thrown at the end so the caller can alert #bot-log.
   */
  async processNotification(nowMs: number = Date.now()): Promise<void> {
    const weekly = reminderRange("weekly", nowMs);
    const daily = reminderRange("daily", nowMs);

    const current = await this.calendar.listEvents(weekly);

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
      const lookup = await this.calendar.getEvent(id);
      switch (lookup.kind) {
        case "cancelled": {
          const reconstructed: ReminderEvent = {
            id,
            title: snap.title ?? "(event)",
            startsAt: snap.startsAt,
            join: { kind: "none" },
          };
          notices.push(buildCancellationMessage(reconstructed));
          cancellations += 1;
          break;
        }
        case "live": {
          const moved: ReminderEvent = {
            id,
            title: snap.title ?? "(event)",
            startsAt: lookup.event.startsAt,
            join: { kind: "none" },
          };
          notices.push(buildRescheduleMessage(moved, snap.startsAt));
          reschedules += 1;
          break;
        }
        case "all-day":
          // A live all-day event (start.date only) that left the timed window: no actionable notice.
          break;
        case "invalid":
          // Still live, but unannounceable (e.g. a Zoom link lost its host key): the adapter has
          // already alerted #bot-log; it just leaves the snapshot without a notice.
          log.info("calendar_sync.event_invalid", { id, reason: lookup.reason });
          break;
      }
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

    // Commit the new baseline before delivering anything: a delivery failure below then loses a
    // notice (alerted via the thrown error) instead of re-posting it everywhere on the next push.
    this.writeSnapshot(current);

    const client = createSlackClient(this.env);
    const failures: string[] = [];

    // Announce each notice to all three event channels.
    const channels = [
      this.env.SLACK_ANNOUNCEMENTS_CHANNEL_ID,
      this.env.SLACK_EVENTS_CHANNEL_ID,
      this.env.SLACK_EVENTADMIN_CHANNEL_ID,
    ];
    for (const notice of notices) {
      for (const channel of channels) {
        try {
          await client.chat.postMessage({
            channel,
            ...notice,
            unfurl_links: false,
            unfurl_media: false,
          });
        } catch (error) {
          log.error("calendar_sync.notice_failed", { channel, error: String(error) });
          failures.push(`notice → ${channel}: ${String(error)}`);
        }
      }
    }

    // Re-sync the scheduled "Starting Soon" queue for the daily window against the live calendar.
    // Fetch the daily window directly (rather than filtering `current`) so this matches sendDaily
    // exactly — the source bounds the events, avoiding a brittle string compare between UTC `…Z`
    // startsAt and the Eastern-offset range bounds.
    try {
      const dailyEvents = await this.calendar.listEvents(daily);
      await reconcileStartingSoon(client, this.env, dailyEvents, nowMs, daily);
    } catch (error) {
      log.error("calendar_sync.reconcile_failed", { error: String(error) });
      failures.push(`reconcile: ${String(error)}`);
    }

    log.info("calendar_sync.processed", {
      cancellations,
      reschedules,
      currentCount: current.length,
      failures: failures.length,
    });

    if (failures.length > 0) {
      throw new Error(
        `calendar sync: ${failures.length} delivery failure(s): ${failures.join("; ")}`,
      );
    }
  }

  /**
   * Renewal alarm: re-create/renew the watch. Self-swallowing after alerting #bot-log, but it
   * re-arms itself for a retry so one failed renewal doesn't silently end automatic renewal
   * (`stopWatch` deletes the alarm, which is what ends the retries).
   */
  override async alarm(): Promise<void> {
    try {
      await this.ensureWatch();
    } catch (error) {
      log.error("calendar_sync.alarm_failed", { error: String(error) });
      await notifyBotLog(this.env, "calendar_sync.alarm_failed", { error: String(error) });
      await this.ctx.storage.setAlarm(Date.now() + RENEW_RETRY_MS);
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
}
