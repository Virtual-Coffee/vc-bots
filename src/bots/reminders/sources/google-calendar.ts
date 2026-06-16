import { DateTime } from "luxon";
import type { Env } from "../../../env";
import { getGoogleAccessToken } from "../../../google/auth";
import { log } from "../../../log";
import type { EventRange, EventSource, ReminderEvent } from "../source";

/**
 * Google Calendar event source: reads the shared "Virtual Coffee Events" calendar via the
 * service account (readonly scope: `https://www.googleapis.com/auth/calendar.readonly`).
 *
 * Extended-property key convention — the service account **manages** this calendar (it wrote
 * the properties via the patch in `scripts/gcal.ts`), so it can read its own
 * `extendedProperties.private` fields. `private` is now the canonical home for Zoom metadata,
 * keeping the host code out of view for anyone merely subscribed to the public calendar (shared
 * properties are visible to all readers). `shared` is still read as a fallback for events that
 * have not yet been migrated.
 *
 * `extendedProperties.private` keys (canonical):
 *   - `joinLink`       — override join URL (beats conferenceData and location).
 *   - `hostCode`       — Zoom host key shown only in the event-admin mirror.
 *   - `slackChannelId` — per-event Slack channel (unused for routing, kept for future).
 *
 * `extendedProperties.shared` keys (legacy fallback):
 *   - `joinLink`       — same semantics, used when private key absent.
 *   - `zoomHostCode`   — legacy name for the Zoom host key.
 *   - `slackChannelId` — same semantics.
 */

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** Raw shape of a Google Calendar Events: list item. */
export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string; // Google serves HTML; htmlToMrkdwn handles it downstream
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { shared?: Record<string, string>; private?: Record<string, string> };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

export function createGoogleCalendarSource(env: Env): EventSource {
  return {
    name: "google",
    async fetchEvents(range: EventRange): Promise<ReminderEvent[]> {
      const token = await getGoogleAccessToken(env);
      const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
      const baseUrl = `${CALENDAR_BASE}/${calendarId}/events`;

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

        const res = await fetch(`${baseUrl}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
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
  };
}

function toReminderEvent(e: GoogleCalendarEvent): ReminderEvent | null {
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

  const startsAt = start.toUTC().toISO() ?? startDateTime;

  let endsAt: string | null = null;
  const endDateTime = e.end?.dateTime;
  if (endDateTime !== undefined) {
    const end = DateTime.fromISO(endDateTime, { setZone: true });
    endsAt = end.isValid ? (end.toUTC().toISO() ?? null) : null;
  }

  const priv = e.extendedProperties?.private;
  const shared = e.extendedProperties?.shared;

  // joinLink: private key wins, then shared, then first video conferenceData entry, then location.
  const videoEntryPoint = e.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === "video" && ep.uri !== undefined,
  );
  const joinLink =
    priv?.["joinLink"] ?? shared?.["joinLink"] ?? videoEntryPoint?.uri ?? e.location ?? null;

  return {
    id: e.id,
    title: e.summary ?? "(untitled event)",
    startsAt,
    endsAt,
    description: e.description ?? null,
    joinLink,
    // Note: the private map's key is `hostCode`; the legacy shared key is `zoomHostCode`.
    zoomHostCode: priv?.["hostCode"] ?? shared?.["zoomHostCode"] ?? null,
    slackChannelId: priv?.["slackChannelId"] ?? shared?.["slackChannelId"] ?? null,
  };
}
