import { GraphQLClient, gql } from "graphql-request";
import { DateTime } from "luxon";
import type { Env } from "../../env";
import { log } from "../../log";

/**
 * CMS access for event reminders (GraphQL via graphql-request — fetch-based, edge-native).
 *
 * ⚠️ PLACEHOLDER SCHEMA. The real VirtualCoffee CMS query/shape and endpoint are not yet
 * known here. `EVENTS_QUERY` and `CmsEvent` below are a reasonable, easily-swappable guess.
 * TODO(cms): replace with the actual query, field names, and response shape once confirmed.
 */

export interface CmsEvent {
  id: string;
  title: string;
  /** ISO-8601 start time (UTC or with offset). */
  startsAt: string;
  /** Optional end time. */
  endsAt?: string | null;
  /** Public URL for the event. */
  url?: string | null;
  /** Description; may contain HTML (rendered with slackify-html). */
  description?: string | null;
}

// TODO(cms): replace with the real CMS query.
export const EVENTS_QUERY = gql`
  query UpcomingEvents {
    events {
      id
      title
      startsAt
      endsAt
      url
      description
    }
  }
`;

interface EventsQueryResponse {
  events: CmsEvent[];
}

export function createCmsClient(env: Env): GraphQLClient {
  return new GraphQLClient(env.CMS_GRAPHQL_URL, {
    headers: { authorization: `Bearer ${env.CMS_TOKEN}` },
  });
}

/** Fetch all events from the CMS (unfiltered). */
export async function fetchEvents(env: Env): Promise<CmsEvent[]> {
  const client = createCmsClient(env);
  log.debug("cms.query", { url: env.CMS_GRAPHQL_URL });
  const data = await client.request<EventsQueryResponse>(EVENTS_QUERY);
  const events = data.events ?? [];
  log.debug("cms.fetched", { count: events.length });
  return events;
}

/**
 * Filter events whose start time falls within `[now, now + windowHours)`.
 * Pure + time-injectable so it can be unit-tested without a live clock.
 */
export function filterUpcoming(
  events: CmsEvent[],
  windowHours: number,
  nowMs: number = Date.now(),
): CmsEvent[] {
  const now = DateTime.fromMillis(nowMs, { zone: "utc" });
  const end = now.plus({ hours: windowHours });
  return events
    .map((e) => ({ e, start: DateTime.fromISO(e.startsAt, { zone: "utc" }) }))
    .filter(({ start }) => start.isValid && start >= now && start < end)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis())
    .map(({ e }) => e);
}
