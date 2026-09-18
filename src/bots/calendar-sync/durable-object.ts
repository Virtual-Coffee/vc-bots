import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import type { ReminderEvent } from "../../events";
import type { CalendarEventLookup, CalendarPort } from "../../google/calendar";
import { createGoogleCalendarPort } from "../../google/calendar";
import { log, setLogLevel } from "../../log";
import { createSlackClient } from "../../slack/client";
import { notifyBotLog } from "../../slack/notify";
import { reconcileStartingSoon } from "../reminders/starting-soon";
import { reminderRange } from "../reminders/source";
import { departedUpcoming, diffSnapshot, type SnapshotEntry } from "./diff";

/**
 * Calendar sync — a single singleton Durable Object (addressed elsewhere via
 * `env.CALENDAR_SYNC.getByName("default")`). It serializes Google Calendar push notifications and
 * the daily cron's `ensureWatch` through one instance, so a notification's snapshot diff never
 * races a baseline seed (same race-free rationale as CoworkingRoom).
 *
 * Two jobs:
 * - **Watch lifecycle** (`ensureWatch` / `stopWatch` / `watchStatus`): register a Calendar
 *   `events/watch` push channel, renew it ~1 day before its 7-day expiry via the DO alarm.
 *   `ensureWatch` also owns the snapshot baseline: it seeds only when the snapshot is missing or
 *   the announced week rolled over (Monday), never on every run — an overwrite would swallow a
 *   change whose push notification is still queued behind it, so the diff would find nothing.
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
/**
 * KV key (next to the SQL tables) holding the `rangeStart` of the announced week the snapshot was
 * last written for — how `ensureWatch` tells a current baseline from a missing/rolled-over one.
 */
const SNAPSHOT_RANGE_START_KEY = "snapshot_range_start";

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
    // The runtime holds deliveries until this settles; nothing to await in a constructor.
    void ctx.blockConcurrencyWhile(() => Promise.resolve(this.migrate()));
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
   * Ensure an active Calendar push channel exists, (re)creating it when missing, near expiry, or
   * registered with a token other than the current `GOOGLE_WATCH_TOKEN`, and arm the renewal
   * alarm. Healthy channels are left in place — just re-arm the alarm. Returns the current status
   * (no token).
   */
  async ensureWatch(nowMs: number = Date.now()): Promise<WatchStatus> {
    const existing = this.getChannel();

    if (
      existing &&
      this.channelIsLive(existing, nowMs) &&
      existing.expiration_ms - RENEW_BUFFER_MS > nowMs
    ) {
      // Still healthy — keep the renewal alarm armed, and heal the baseline if the first seed
      // failed after this row was persisted or the announced week has rolled over since.
      await this.ctx.storage.setAlarm(existing.expiration_ms - RENEW_BUFFER_MS);
      if (!(await this.snapshotIsCurrent(nowMs))) await this.seed(nowMs);
      log.info("calendar_sync.watch_healthy", {
        channelId: existing.id,
        expiresAt: existing.expiration_ms,
      });
      return { active: true, channelId: existing.id, expiresAt: existing.expiration_ms };
    }

    // (Re)create. The replacement is created and persisted BEFORE the old channel is stopped, so
    // a failure here leaves the old (still-registered) channel and its row intact. A rotated
    // `GOOGLE_WATCH_TOKEN` lands here too: Google keeps sending whatever token the channel was
    // registered with, so the router would reject every push from the old channel — only a fresh
    // channel (registered with the current token) makes pushes verifiable again.
    const { channelId, resourceId, expirationMs } = await this.calendar.watch(this.notifyAddress());

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

    // Establish the snapshot baseline when it's missing (first-time setup) or stale (the announced
    // week rolled over) so the next notification has something to diff against — otherwise every
    // event would look "new". A current baseline is left alone: see the class doc.
    if (!(await this.snapshotIsCurrent(nowMs))) await this.seed(nowMs);

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
      throw new Error(
        "Google refused to stop the calendar watch channel; the watch is still registered",
      );
    }
    this.sql.exec("DELETE FROM channel");
    await this.ctx.storage.deleteAlarm();
    log.info("calendar_sync.watch_stopped", { channelId: existing.id });
    return { stopped: true };
  }

  /**
   * Current watch status (no token). Active = a row exists, isn't past its expiry, and was
   * registered with the current `GOOGLE_WATCH_TOKEN` (a rotated token means the router rejects
   * its pushes, so it isn't delivering even though Google still has it).
   */
  watchStatus(): WatchStatus {
    const existing = this.getChannel();
    if (!existing) return { active: false, channelId: null, expiresAt: null };
    const active = this.channelIsLive(existing, Date.now());
    return { active, channelId: existing.id, expiresAt: existing.expiration_ms };
  }

  /**
   * Overwrite the snapshot to match the current weekly window — no notices, no reconcile. The
   * baseline mid-week notifications diff against; `ensureWatch` calls it only when the snapshot is
   * missing or belongs to a previous week (it is never a routine refresh — see the class doc).
   */
  async seed(nowMs: number = Date.now()): Promise<void> {
    const range = reminderRange("weekly", nowMs);
    const events = await this.calendar.listEvents(range);
    await this.writeSnapshot(events, range.rangeStart);
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
   * Core push-notification handler. Diffs the live weekly window against the last snapshot
   * (the rules live in `./diff.ts`), persists the new snapshot, then posts standout notices to
   * the three event channels and reconciles the scheduled "Starting Soon" queue for the daily
   * window.
   *
   * Delivery failures don't stop the run: each post and the reconcile are isolated, and one
   * aggregate error is thrown at the end so the caller can alert #bot-log.
   */
  async processNotification(nowMs: number = Date.now()): Promise<void> {
    const weekly = reminderRange("weekly", nowMs);
    const daily = reminderRange("daily", nowMs);

    const current = await this.calendar.listEvents(weekly);

    const prior = new Map<string, SnapshotEntry>();
    for (const row of this.sql.exec<SnapshotRow>("SELECT * FROM event_snapshot").toArray()) {
      prior.set(row.id, { id: row.id, startsAt: row.starts_at, title: row.title });
    }
    const currentById = new Map<string, ReminderEvent>();
    for (const e of current) currentById.set(e.id, e);

    // Departed-and-upcoming ids need a single-event lookup to tell cancelled from moved.
    const lookups = new Map<string, CalendarEventLookup>();
    for (const id of departedUpcoming(prior, currentById, nowMs)) {
      lookups.set(id, await this.calendar.getEvent(id));
    }

    const { notices, cancellations, reschedules, invalid } = diffSnapshot(
      prior,
      currentById,
      lookups,
      nowMs,
    );
    for (const { id, reason } of invalid) {
      // Still live, but unannounceable (e.g. a Zoom link lost its host key): the adapter has
      // already alerted #bot-log; it just leaves the snapshot without a notice.
      log.info("calendar_sync.event_invalid", { id, reason });
    }

    // Commit the new baseline before delivering anything: a delivery failure below then loses a
    // notice (alerted via the thrown error) instead of re-posting it everywhere on the next push.
    await this.writeSnapshot(current, weekly.rangeStart);

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
   * `PUBLIC_BASE_URL` (the Netlify rewrite host; Google needs a trusted HTTPS certificate there —
   * see the `PUBLIC_BASE_URL` note in `src/env.ts`). There's no inbound request here (cron/alarm),
   * so unlike the join redirect there's no origin fallback: an empty `PUBLIC_BASE_URL` means no
   * watch can be registered.
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

  /**
   * A stored channel is live when it hasn't expired AND was registered with the current
   * `GOOGLE_WATCH_TOKEN` — otherwise its pushes fail the router's token check and it needs
   * replacing. Narrows `expiration_ms` for the caller.
   */
  private channelIsLive(
    row: ChannelRow,
    nowMs: number,
  ): row is ChannelRow & { expiration_ms: number } {
    return (
      row.expiration_ms !== null &&
      row.expiration_ms > nowMs &&
      row.token === this.env.GOOGLE_WATCH_TOKEN
    );
  }

  /**
   * Is the stored snapshot the baseline for the week `nowMs` falls in? False when no snapshot has
   * been written yet or the last one was written for a previous announced week.
   */
  private async snapshotIsCurrent(nowMs: number): Promise<boolean> {
    const stored = await this.ctx.storage.get<string>(SNAPSHOT_RANGE_START_KEY);
    return stored === reminderRange("weekly", nowMs).rangeStart;
  }

  /** Replace the whole snapshot with the given events, tagged with the week it was taken for. */
  private async writeSnapshot(events: ReminderEvent[], rangeStart: string): Promise<void> {
    this.sql.exec("DELETE FROM event_snapshot");
    for (const e of events) {
      this.sql.exec(
        "INSERT INTO event_snapshot (id, starts_at, title) VALUES (?, ?, ?)",
        e.id,
        e.startsAt,
        e.title,
      );
    }
    await this.ctx.storage.put(SNAPSHOT_RANGE_START_KEY, rangeStart);
  }
}
