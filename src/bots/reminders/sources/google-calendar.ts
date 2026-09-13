import { DateTime } from "luxon";
import type { Env } from "../../../env";
import { getGoogleAccessToken } from "../../../google/auth";
import { log } from "../../../log";
import type { EventRange, EventSource, ReminderEvent } from "../source";

/**
 * Google Calendar event source: reads the private "Virtual Coffee Events" calendar via the
 * service account (scope `https://www.googleapis.com/auth/calendar`, see `src/google/auth.ts`).
 * Join Link = `location`, host key = `extendedProperties.private.hostCode` (docs/adr/0001).
 */

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** Raw shape of a Google Calendar Events: list item. */
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

  // Join Link: `location` is canonical; a video conferenceData entry is the fallback.
  const videoEntryPoint = e.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === "video" && ep.uri !== undefined,
  );
  const joinLink = e.location ?? videoEntryPoint?.uri ?? null;

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
