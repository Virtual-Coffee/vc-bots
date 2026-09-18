import { DateTime } from "luxon";
import type { Env } from "../env";
import {
  deriveJoinInfo,
  type EventRange,
  type InvalidEventReason,
  type JoinInfo,
  type ReminderEvent,
} from "../events";
import type { components, paths } from "../generated/google-calendar-v3";
import { apiError, createApiClient } from "../http/client";
import { log } from "../log";
import { notifyBotLog } from "../slack/notify";
import { fetchGoogleAccessToken } from "./auth";

/**
 * Google Calendar adapter — the one module that speaks the Calendar v3 wire protocol. Everything
 * else (the reminders `EventSource`, the `CalendarSync` DO) goes through the `CalendarPort` seam
 * and sees only `ReminderEvent`s and small result unions; tests fake the port
 * (`test/helpers/calendar-fake.ts`).
 *
 * Reads the private "Virtual Coffee Events" calendar via the service account (scope
 * `https://www.googleapis.com/auth/calendar.events.readonly`, see `src/google/auth.ts`). Join
 * Link = `location`, host key = `extendedProperties.private.hostCode` (docs/adr/0001). A Zoom
 * Join Link without a host key makes the event **invalid**: it is dropped from `listEvents` with
 * a `#bot-log` alert and reported by `getEvent`, so the bad calendar entry never reaches a
 * sender (docs/adr/0002).
 *
 * Each adapter instance caches its access token (~1h lifetime, no refresh token) and re-fetches
 * it shortly before expiry. There's no cross-request locking, so overlapping runs may each mint
 * a token; last-writer-wins is harmless.
 *
 * ⚠️ The access token, the watch token (`GOOGLE_WATCH_TOKEN`), and the watch address are
 * credentials — never log them. Channel ids are random uuids, safe to log.
 */

const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
/** Google's default (and max) TTL for a calendar push channel: 7 days. */
const WATCH_TTL_SECONDS = 604800;
/** Re-fetch this far ahead of expiry to avoid using a token mid-flight as it lapses. */
const EXPIRY_SKEW_MS = 60_000;

export interface CalendarPort {
  /**
   * Timed, non-cancelled, valid events in `[rangeStart, rangeEnd)`; throws on a non-OK response.
   * Invalid events (a Zoom Join Link with no host key) are dropped and alerted to `#bot-log`.
   */
  listEvents(range: EventRange): Promise<ReminderEvent[]>;
  /**
   * Look up a single event by id. 404/410 (gone) counts as cancelled; an invalid mapping is
   * reported as `invalid`; other non-OK responses throw so a transient API failure surfaces
   * rather than masquerading as a deletion.
   */
  getEvent(id: string): Promise<CalendarEventLookup>;
  /** Register a push channel posting to `address`; throws on failure. */
  watch(address: string): Promise<CalendarWatch>;
  /**
   * Stop a push channel. `"gone"` means Google no longer knows it (404/410 — already expired or
   * stopped), which callers treat like success. Failures are logged (warn) and reported, never
   * thrown — callers decide whether they matter.
   */
  stopChannel(channelId: string, resourceId: string | null): Promise<StopChannelResult>;
}

export type CalendarEventLookup =
  | { kind: "live"; event: ReminderEvent }
  /** Cancelled or gone — either way no longer happening. */
  | { kind: "cancelled" }
  /** Live but `start.date` only — no timed slot to announce. */
  | { kind: "all-day" }
  /** Live and timed but `start.dateTime` is unparseable — nothing to correct to. */
  | { kind: "bad-start" }
  /** Live and timed, but unannounceable (docs/adr/0002). */
  | { kind: "invalid"; reason: InvalidEventReason };

/** Total result of mapping a wire event: an event, a benign skip, or an invalid entry. */
export type MappedEvent =
  | { kind: "event"; event: ReminderEvent }
  /** Nothing to announce: cancelled, all-day, or an unparseable `start.dateTime`. */
  | { kind: "skipped"; reason: "cancelled" | "all-day" | "bad-start" }
  | { kind: "invalid"; reason: InvalidEventReason };

export interface CalendarWatch {
  channelId: string;
  resourceId: string;
  expirationMs: number;
}

export type StopChannelResult = "stopped" | "gone" | "failed";

/**
 * Raw shape of a Google Calendar Events resource (list item / get body), as the vendored spec
 * declares it (`docs/adr/0012`) except that `id` is required: Google always sends one, and the
 * adapter treats a body without it as malformed. `description` is Markdown, rendered downstream
 * with slackify-markdown.
 */
export type GoogleCalendarEvent = components["schemas"]["Event"] & { id: string };

function hasId(e: components["schemas"]["Event"]): e is GoogleCalendarEvent {
  return typeof e.id === "string";
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export function createGoogleCalendarPort(env: Env): CalendarPort {
  const calendarId = env.GOOGLE_CALENDAR_ID;
  let cache: CachedToken | undefined;

  /** A valid access token, reusing the cached one until it nears expiry. */
  async function accessToken(): Promise<string> {
    const nowMs = Date.now();
    if (cache && cache.expiresAtMs - EXPIRY_SKEW_MS > nowMs) {
      log.debug("google.token.cache_hit");
      return cache.accessToken;
    }
    log.debug("google.token.fetch");
    const { accessToken, expiresInSec } = await fetchGoogleAccessToken(env, nowMs);
    cache = { accessToken, expiresAtMs: nowMs + expiresInSec * 1000 };
    log.debug("google.token.fetched", { expiresInSec });
    return accessToken;
  }

  const api = createApiClient<paths>({ baseUrl: CALENDAR_BASE_URL, bearer: accessToken });

  return {
    async listEvents(range) {
      const items: GoogleCalendarEvent[] = [];
      let pageToken: string | undefined;

      do {
        const { data, error, response } = await api.GET("/calendars/{calendarId}/events", {
          params: {
            path: { calendarId },
            query: {
              timeMin: range.rangeStart,
              timeMax: range.rangeEnd,
              singleEvents: true,
              orderBy: "startTime",
              maxResults: 250,
              pageToken,
            },
          },
        });

        if (!response.ok) {
          throw apiError("google", "Google Calendar API error", { response, error });
        }

        for (const item of data?.items ?? []) {
          if (!hasId(item)) {
            throw new Error("Google Calendar events list returned an unexpected body shape");
          }
          items.push(item);
        }
        pageToken = data?.nextPageToken;
      } while (pageToken !== undefined);

      log.debug("google.fetched", { count: items.length });
      const events: ReminderEvent[] = [];
      for (const e of items) {
        const mapped = toReminderEvent(e);
        if (mapped.kind === "event") {
          events.push(mapped.event);
        } else if (mapped.kind === "invalid") {
          // Skip-and-alert rather than fail the run: one bad calendar entry must not black-hole
          // every other event. Repeats on every listing until the calendar is fixed.
          const title = e.summary ?? "(untitled event)";
          log.warn("calendar.event_rejected", { id: e.id, title, reason: mapped.reason });
          await notifyBotLog(env, "calendar.event_rejected", {
            id: e.id,
            title,
            reason: mapped.reason,
            detail: "Zoom event has no hostCode on the calendar; skipped until it is set",
          });
        }
      }
      return events;
    },

    async getEvent(id) {
      const { data, error, response } = await api.GET("/calendars/{calendarId}/events/{eventId}", {
        params: { path: { calendarId, eventId: id } },
      });
      if (response.status === 404 || response.status === 410) return { kind: "cancelled" };
      if (!response.ok) {
        throw apiError("google", "Google Calendar get event failed", { response, error });
      }
      if (data === undefined || !hasId(data)) {
        throw new Error("Google Calendar get event returned an unexpected body shape");
      }
      const e = data;
      if (e.status === "cancelled") return { kind: "cancelled" };
      if (e.start?.dateTime === undefined) return { kind: "all-day" };
      const mapped = toReminderEvent(e);
      if (mapped.kind === "event") return { kind: "live", event: mapped.event };
      if (mapped.kind === "invalid") return { kind: "invalid", reason: mapped.reason };
      // Cancelled and all-day were returned above, so `bad-start` is the only skip left. Never a
      // `live` event with the raw string: the diff would read it as a reschedule to garbage.
      return { kind: "bad-start" };
    },

    async watch(address) {
      const channelId = crypto.randomUUID();
      const { data, error, response } = await api.POST("/calendars/{calendarId}/events/watch", {
        params: { path: { calendarId } },
        body: {
          id: channelId,
          type: "web_hook",
          address,
          token: env.GOOGLE_WATCH_TOKEN,
          params: { ttl: String(WATCH_TTL_SECONDS) },
        },
      });
      if (!response.ok) {
        // Google's error body may be useful; the request body (carrying address/token) is not echoed.
        throw apiError("google", "Google Calendar watch failed", { response, error });
      }
      if (typeof data?.resourceId !== "string" || typeof data.expiration !== "string") {
        throw new Error("Google Calendar watch returned an unexpected body shape");
      }
      return { channelId, resourceId: data.resourceId, expirationMs: Number(data.expiration) };
    },

    async stopChannel(channelId, resourceId) {
      if (!resourceId) return "gone";
      try {
        const { response } = await api.POST("/channels/stop", {
          body: { id: channelId, resourceId },
        });
        if (response.ok) return "stopped";
        if (response.status === 404 || response.status === 410) return "gone";
        log.warn("calendar_sync.stop_channel_failed", { channelId, status: response.status });
        return "failed";
      } catch (error) {
        log.warn("calendar_sync.stop_channel_failed", { channelId, error: String(error) });
        return "failed";
      }
    },
  };
}

/**
 * Map a wire event to a `ReminderEvent`. Total: a `skipped` result means there is no timed slot to
 * announce (cancelled, all-day — `start.date` only — or an unparseable `start.dateTime`); an
 * `invalid` one means the entry is timed and live but can't be announced (docs/adr/0002).
 */
export function toReminderEvent(e: GoogleCalendarEvent): MappedEvent {
  if (e.status === "cancelled") {
    return { kind: "skipped", reason: "cancelled" };
  }

  const startDateTime = e.start?.dateTime;
  if (startDateTime === undefined) {
    // All-day events have only start.date. Skip them: starting-soon messages are scheduled at
    // start − 10 min; mapping an all-day event to midnight would cause misfires.
    log.warn("google.event_all_day_skipped", { id: e.id, date: e.start?.date });
    return { kind: "skipped", reason: "all-day" };
  }

  const start = DateTime.fromISO(startDateTime, { setZone: true });
  if (!start.isValid) {
    log.warn("google.event_invalid_start", { id: e.id, start: startDateTime });
    return { kind: "skipped", reason: "bad-start" };
  }

  return mapTimedEvent(e, start.toUTC().toISO() ?? startDateTime);
}

/** The field mapping for a timed event whose `startsAt` has already been resolved. */
function mapTimedEvent(
  e: GoogleCalendarEvent,
  startsAt: string,
): Extract<MappedEvent, { kind: "event" | "invalid" }> {
  let endsAt: string | null = null;
  const endDateTime = e.end?.dateTime;
  if (endDateTime !== undefined) {
    const end = DateTime.fromISO(endDateTime, { setZone: true });
    endsAt = end.isValid ? (end.toUTC().toISO() ?? null) : null;
  }

  const join = joinInfoOf(e);
  if (join === null) return { kind: "invalid", reason: "zoom-no-host-key" };

  return {
    kind: "event",
    event: {
      id: e.id,
      title: e.summary ?? "(untitled event)",
      startsAt,
      endsAt,
      description: e.description ?? null,
      join,
    },
  };
}

/**
 * The wire fields behind the Join Link rule (`deriveJoinInfo`, `src/events.ts`): `location` is
 * canonical (blank/whitespace counts as absent), a video conferenceData entry is the fallback,
 * and the host code is the private `hostCode` property (empty/whitespace counts as absent).
 */
function joinInfoOf(e: GoogleCalendarEvent): JoinInfo | null {
  const videoEntryPoint = e.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === "video" && ep.uri !== undefined,
  );
  const location = e.location?.trim() || null;
  const link = location ?? videoEntryPoint?.uri ?? null;
  const hostCode = e.extendedProperties?.private?.hostCode?.trim() || null;
  return deriveJoinInfo(link, hostCode);
}
