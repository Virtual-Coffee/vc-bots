import { GraphQLClient, gql } from "graphql-request";
import { DateTime } from "luxon";
import type { Env } from "../../../env";
import { deriveJoinInfo, type InvalidEventReason } from "../../../events";
import { UnsupportedHtmlError, htmlToMarkdown } from "../../../html-to-markdown";
import { log } from "../../../log";
import { notifyBotLog } from "../../../slack/notify";
import type { EventRange, EventSource, ReminderEvent } from "../source";

/**
 * CMS event source: Craft CMS + Solspace Calendar over GraphQL (graphql-request —
 * fetch-based, edge-native). Ported from the old Netlify webhooks bot.
 *
 * Interim: the `EVENT_SOURCE` default until the Google Calendar cutover, so the Worker can
 * ship before the calendar is canonical (docs/adr/0001 §Consequences, dated note). It maps
 * onto the same model as the Google adapter — the Join Link rule is `deriveJoinInfo`
 * (docs/adr/0002), so a Zoom link without `eventZoomHostCode` is an invalid event: dropped
 * with a `#bot-log` alert, never announced. Descriptions are Craft-rendered HTML, converted
 * to Markdown; an unsupported tag degrades to stripped text rather than losing the event.
 *
 * Solspace exposes one GraphQL type per calendar (`<handle>_Event`), so fetching is
 * two-step: query the calendar handles first, then build the events query with one
 * inline fragment per handle for the custom fields.
 *
 * ⚠️ `eventZoomHostCode` is the Zoom host key — event-admin mirror only, never log it.
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
      const raw = data.solspace_calendar.events ?? [];
      log.debug("cms.fetched", { count: raw.length });

      const events: ReminderEvent[] = [];
      for (const e of raw) {
        const mapped = toReminderEvent(e);
        if (mapped.kind === "event") {
          events.push(mapped.event);
        } else if (mapped.kind === "invalid") {
          // Skip-and-alert rather than fail the run, as the Google adapter does: one bad entry
          // must not black-hole every other event. Repeats on every fetch until the CMS is fixed.
          log.warn("cms.event_rejected", { id: e.id, title: e.title, reason: mapped.reason });
          await notifyBotLog(env, "cms.event_rejected", {
            id: e.id,
            title: e.title,
            reason: mapped.reason,
            detail: "Zoom event has no host code in the CMS; skipped until it is set",
          });
        }
      }
      return events;
    },
  };
}

type MappedCmsEvent =
  | { kind: "event"; event: ReminderEvent }
  | { kind: "skipped"; reason: "bad-start" }
  | { kind: "invalid"; reason: InvalidEventReason };

function toReminderEvent(e: CmsEvent): MappedCmsEvent {
  // Parsed in UTC — matches the old bot, which parsed in server-local time (UTC on
  // Netlify and workerd alike). Solspace's "localized" strings carry no offset.
  const start = DateTime.fromISO(e.startDateLocalized, { zone: "utc" });
  if (!start.isValid) {
    log.warn("cms.event_invalid_start", { id: e.id, start: e.startDateLocalized });
    return { kind: "skipped", reason: "bad-start" };
  }
  const end = DateTime.fromISO(e.endDateLocalized, { zone: "utc" });

  const join = deriveJoinInfo(e.eventJoinLink?.trim() || null, e.eventZoomHostCode?.trim() || null);
  if (join === null) return { kind: "invalid", reason: "zoom-no-host-key" };

  return {
    kind: "event",
    event: {
      id: e.id,
      title: e.title,
      startsAt: start.toISO() ?? e.startDateLocalized,
      endsAt: end.isValid ? end.toISO() : null,
      description: descriptionOf(e),
      join,
    },
  };
}

/** Craft HTML → Markdown; an unsupported tag keeps the event with the tags stripped. */
function descriptionOf(e: CmsEvent): string | null {
  const html = e.eventCalendarDescription;
  if (html === undefined || html === null || html.trim() === "") return null;
  try {
    return htmlToMarkdown(html);
  } catch (error) {
    if (!(error instanceof UnsupportedHtmlError)) throw error;
    log.warn("cms.description_unsupported_html", { id: e.id, tagName: error.tagName });
    return html.replace(/<[^>]+>/g, "").trim();
  }
}
