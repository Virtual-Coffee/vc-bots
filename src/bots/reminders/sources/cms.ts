import { GraphQLClient, gql } from "graphql-request";
import { DateTime } from "luxon";
import type { Env } from "../../../env";
import { log } from "../../../log";
import type { EventRange, EventSource, ReminderEvent } from "../source";

/**
 * CMS event source: Craft CMS + Solspace Calendar over GraphQL (graphql-request —
 * fetch-based, edge-native). Ported from the old Netlify webhooks bot.
 *
 * Solspace exposes one GraphQL type per calendar (`<handle>_Event`), so fetching is
 * two-step: query the calendar handles first, then build the events query with one
 * inline fragment per handle for the custom fields.
 */

/** Raw Solspace event shape. Fragment fields only exist via the per-calendar fragments. */
interface CmsEvent {
  id: string;
  title: string;
  startDateLocalized: string;
  endDateLocalized: string;
  eventCalendarDescription?: string | null;
  eventJoinLink?: string | null;
  eventZoomHostCode?: string | null;
  eventSlackAnnouncementsChannelId?: string | null;
}

interface CalendarsResponse {
  solspace_calendar: { calendars: Array<{ handle: string }> };
}

interface EventsResponse {
  solspace_calendar: { events: CmsEvent[] };
}

export const CALENDARS_QUERY = gql`
  query getCalendars {
    solspace_calendar {
      calendars {
        handle
      }
    }
  }
`;

export function createEventsQuery(handles: string[]): string {
  return gql`
    query getEvents($rangeStart: String!, $rangeEnd: String!) {
      solspace_calendar {
        events(rangeStart: $rangeStart, rangeEnd: $rangeEnd) {
          id
          title
          startDateLocalized
          endDateLocalized
          ${handles
            .map(
              (handle) => `
          ... on ${handle}_Event {
            eventCalendarDescription
            eventJoinLink
            eventZoomHostCode
            eventSlackAnnouncementsChannelId
            id
          }
          `,
            )
            .join("")}
        }
      }
    }
  `;
}

export function createCmsClient(env: Env): GraphQLClient {
  return new GraphQLClient(env.CMS_GRAPHQL_URL, {
    headers: { authorization: `Bearer ${env.CMS_TOKEN}` },
  });
}

export function createCmsSource(env: Env): EventSource {
  return {
    name: "cms",
    async fetchEvents(range: EventRange): Promise<ReminderEvent[]> {
      const client = createCmsClient(env);
      log.debug("cms.query", { url: env.CMS_GRAPHQL_URL, ...range });
      const calendars = await client.request<CalendarsResponse>(CALENDARS_QUERY);
      const handles = calendars.solspace_calendar.calendars.map((c) => c.handle);
      const data = await client.request<EventsResponse>(createEventsQuery(handles), {
        rangeStart: range.rangeStart,
        rangeEnd: range.rangeEnd,
      });
      const events = data.solspace_calendar.events ?? [];
      log.debug("cms.fetched", { count: events.length });
      return events.flatMap((e) => toReminderEvent(e) ?? []);
    },
  };
}

function toReminderEvent(e: CmsEvent): ReminderEvent | null {
  // Parsed in UTC — matches the old bot, which parsed in server-local time (UTC on
  // Netlify and workerd alike). Solspace's "localized" strings carry no offset.
  const start = DateTime.fromISO(e.startDateLocalized, { zone: "utc" });
  if (!start.isValid) {
    log.warn("cms.event_invalid_start", { id: e.id, start: e.startDateLocalized });
    return null;
  }
  const end = DateTime.fromISO(e.endDateLocalized, { zone: "utc" });
  return {
    id: e.id,
    title: e.title,
    startsAt: start.toISO() ?? e.startDateLocalized,
    endsAt: end.isValid ? end.toISO() : null,
    description: e.eventCalendarDescription ?? null,
    joinLink: e.eventJoinLink ?? null,
    zoomHostCode: e.eventZoomHostCode ?? null,
    slackChannelId: e.eventSlackAnnouncementsChannelId ?? null,
  };
}
