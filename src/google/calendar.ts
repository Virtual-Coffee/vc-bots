import { DateTime } from "luxon";
import type { Env } from "../env";
import type { EventRange, ReminderEvent } from "../events";
import { log } from "../log";
import { fetchGoogleAccessToken } from "./auth";

/**
 * Google Calendar adapter — the one module that speaks the Calendar v3 wire protocol. Everything
 * else (the reminders `EventSource`, the `CalendarSync` DO) goes through the `CalendarPort` seam
 * and sees only `ReminderEvent`s and small result unions; tests fake the port
 * (`test/helpers/calendar-fake.ts`).
 *
 * Reads the private "Virtual Coffee Events" calendar via the service account (scope
 * `https://www.googleapis.com/auth/calendar`, see `src/google/auth.ts`). Join Link = `location`,
 * host key = `extendedProperties.private.hostCode` (docs/adr/0001).
 *
 * Each adapter instance caches its access token (~1h lifetime, no refresh token) and re-fetches
 * it shortly before expiry. There's no cross-request locking, so overlapping runs may each mint
 * a token; last-writer-wins is harmless.
 *
 * ⚠️ The access token, the watch token (`GOOGLE_WATCH_TOKEN`), and the watch address are
 * credentials — never log them. Channel ids are random uuids, safe to log.
 */

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const CHANNELS_STOP_URL = "https://www.googleapis.com/calendar/v3/channels/stop";
/** Google's default (and max) TTL for a calendar push channel: 7 days. */
const WATCH_TTL_SECONDS = 604800;
/** Re-fetch this far ahead of expiry to avoid using a token mid-flight as it lapses. */
const EXPIRY_SKEW_MS = 60_000;

export interface CalendarPort {
  /** Timed, non-cancelled events in `[rangeStart, rangeEnd)`; throws on a non-OK response. */
  listEvents(range: EventRange): Promise<ReminderEvent[]>;
  /**
   * Look up a single event by id. 404/410 (gone) counts as cancelled; other non-OK responses
   * throw so a transient API failure surfaces rather than masquerading as a deletion.
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
  | { kind: "all-day" };

export interface CalendarWatch {
  channelId: string;
  resourceId: string;
  expirationMs: number;
}

export type StopChannelResult = "stopped" | "gone" | "failed";

/** Raw shape of a Google Calendar Events resource (list item / get body). */
export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string; // Markdown; rendered downstream with slackify-markdown
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  extendedProperties?: { private?: Record<string, string> };
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export function createGoogleCalendarPort(env: Env): CalendarPort {
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
  const eventsUrl = `${CALENDAR_BASE}/${calendarId}/events`;
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

  async function authHeaders(json = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}` };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  return {
    async listEvents(range) {
      const items: GoogleCalendarEvent[] = [];
      let pageToken: string | undefined;

      do {
        const params = new URLSearchParams({
          timeMin: range.rangeStart,
          timeMax: range.rangeEnd,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
        });
        if (pageToken !== undefined) {
          params.set("pageToken", pageToken);
        }

        const res = await fetch(`${eventsUrl}?${params.toString()}`, {
          headers: await authHeaders(),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Google Calendar API error: ${res.status} ${body}`);
        }

        const page = await res.json<{
          items?: GoogleCalendarEvent[];
          nextPageToken?: string;
        }>();

        for (const item of page.items ?? []) {
          items.push(item);
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);

      log.debug("google.fetched", { count: items.length });
      return items.flatMap((e) => toReminderEvent(e) ?? []);
    },

    async getEvent(id) {
      const res = await fetch(`${eventsUrl}/${encodeURIComponent(id)}`, {
        headers: await authHeaders(),
      });
      if (res.status === 404 || res.status === 410) return { kind: "cancelled" };
      if (!res.ok) {
        throw new Error(`Google Calendar get event failed: ${res.status} ${await res.text()}`);
      }
      const e = await res.json<GoogleCalendarEvent>();
      if (e.status === "cancelled") return { kind: "cancelled" };
      const startDateTime = e.start?.dateTime;
      if (startDateTime === undefined) return { kind: "all-day" };
      // An unparseable start.dateTime is still a live timed event here: fall back to the raw
      // string (what the sync did before the port) rather than dropping it as `listEvents` does.
      const event = toReminderEvent(e) ?? mapTimedEvent(e, startDateTime);
      return { kind: "live", event };
    },

    async watch(address) {
      const channelId = crypto.randomUUID();
      const res = await fetch(`${eventsUrl}/watch`, {
        method: "POST",
        headers: await authHeaders(true),
        body: JSON.stringify({
          id: channelId,
          type: "web_hook",
          address,
          token: env.GOOGLE_WATCH_TOKEN,
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
      return { channelId, resourceId: body.resourceId, expirationMs: Number(body.expiration) };
    },

    async stopChannel(channelId, resourceId) {
      if (!resourceId) return "gone";
      try {
        const res = await fetch(CHANNELS_STOP_URL, {
          method: "POST",
          headers: await authHeaders(true),
          body: JSON.stringify({ id: channelId, resourceId }),
        });
        if (res.ok) return "stopped";
        if (res.status === 404 || res.status === 410) return "gone";
        log.warn("calendar_sync.stop_channel_failed", { channelId, status: res.status });
        return "failed";
      } catch (error) {
        log.warn("calendar_sync.stop_channel_failed", { channelId, error: String(error) });
        return "failed";
      }
    },
  };
}

/**
 * Map a wire event to a `ReminderEvent`, or null when it has no timed slot to announce:
 * cancelled, all-day (`start.date` only), or an unparseable `start.dateTime`.
 */
export function toReminderEvent(e: GoogleCalendarEvent): ReminderEvent | null {
  if (e.status === "cancelled") {
    return null;
  }

  const startDateTime = e.start?.dateTime;
  if (startDateTime === undefined) {
    // All-day events have only start.date. Skip them: starting-soon messages are scheduled at
    // start − 10 min; mapping an all-day event to midnight would cause misfires.
    log.warn("google.event_all_day_skipped", { id: e.id, date: e.start?.date });
    return null;
  }

  const start = DateTime.fromISO(startDateTime, { setZone: true });
  if (!start.isValid) {
    log.warn("google.event_invalid_start", { id: e.id, start: startDateTime });
    return null;
  }

  return mapTimedEvent(e, start.toUTC().toISO() ?? startDateTime);
}

/** The field mapping for a timed event whose `startsAt` has already been resolved. */
function mapTimedEvent(e: GoogleCalendarEvent, startsAt: string): ReminderEvent {
  let endsAt: string | null = null;
  const endDateTime = e.end?.dateTime;
  if (endDateTime !== undefined) {
    const end = DateTime.fromISO(endDateTime, { setZone: true });
    endsAt = end.isValid ? (end.toUTC().toISO() ?? null) : null;
  }

  // Join Link: `location` is canonical (blank/whitespace counts as absent); a video
  // conferenceData entry is the fallback.
  const videoEntryPoint = e.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === "video" && ep.uri !== undefined,
  );
  const location = e.location?.trim() || null;
  const joinLink = location ?? videoEntryPoint?.uri ?? null;

  // Host key: the private `hostCode` property; empty/whitespace counts as absent.
  const hostKey = e.extendedProperties?.private?.hostCode?.trim() || null;

  return {
    id: e.id,
    title: e.summary ?? "(untitled event)",
    startsAt,
    endsAt,
    description: e.description ?? null,
    joinLink,
    hostKey,
  };
}
