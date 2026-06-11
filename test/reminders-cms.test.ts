import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDARS_QUERY,
  createCmsSource,
  createEventsQuery,
} from "../src/bots/reminders/sources/cms";

const RANGE = {
  rangeStart: "2026-05-28T08:00:00.000-04:00",
  rangeEnd: "2026-05-29T08:00:00.000-04:00",
};

interface RecordedCall {
  url: string;
  body: string;
  authorization: string | null;
}
let recorded: RecordedCall[];
let cmsEvents: Array<Record<string, unknown>>;

beforeEach(() => {
  recorded = [];
  cmsEvents = [];
  const spy = vi.fn(
    async (input: unknown, init?: { body?: unknown; headers?: HeadersInit }) => {
      let url: string;
      let body = "";
      let authorization: string | null = null;
      if (input instanceof Request) {
        url = input.url;
        body = new TextDecoder().decode(await input.clone().arrayBuffer());
        authorization = input.headers.get("authorization");
      } else {
        url = String(input);
        body = typeof init?.body === "string" ? init.body : "";
        authorization = new Headers(init?.headers).get("authorization");
      }
      recorded.push({ url, body, authorization });

      if (body.includes("getCalendars")) {
        return Response.json({
          data: {
            solspace_calendar: { calendars: [{ handle: "officeHours" }, { handle: "vcEvents" }] },
          },
        });
      }
      return Response.json({ data: { solspace_calendar: { events: cmsEvents } } });
    },
  );
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

describe("createEventsQuery", () => {
  it("builds one inline fragment per calendar handle with the custom fields", () => {
    const query = createEventsQuery(["officeHours", "vcEvents"]);
    expect(query).toContain("... on officeHours_Event");
    expect(query).toContain("... on vcEvents_Event");
    expect(query).toContain("eventCalendarDescription");
    expect(query).toContain("eventJoinLink");
    expect(query).toContain("eventZoomHostCode");
    expect(query).toContain("eventSlackAnnouncementsChannelId");
  });
});

describe("createCmsSource", () => {
  it("fetches calendars then events with the range variables and bearer auth", async () => {
    await createCmsSource(env).fetchEvents(RANGE);

    const cmsCalls = recorded.filter((r) => r.url === env.CMS_GRAPHQL_URL);
    expect(cmsCalls).toHaveLength(2);
    expect(cmsCalls[0]!.body).toContain("getCalendars");
    expect(cmsCalls[0]!.authorization).toBe(`Bearer ${env.CMS_TOKEN}`);

    const eventsCall = JSON.parse(cmsCalls[1]!.body) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(eventsCall.query).toContain("... on officeHours_Event");
    expect(eventsCall.variables).toEqual(RANGE);
  });

  it("maps Solspace fields to the normalized ReminderEvent shape", async () => {
    cmsEvents = [
      {
        id: "42",
        title: "Coffee Table Talk",
        startDateLocalized: "2026-05-28T15:00:00", // offset-less, parsed as UTC
        endDateLocalized: "2026-05-28T16:00:00",
        eventCalendarDescription: "<p>Hi</p>",
        eventJoinLink: "https://zoom.us/j/1",
        eventZoomHostCode: "1234",
        eventSlackAnnouncementsChannelId: "C123",
      },
    ];
    const events = await createCmsSource(env).fetchEvents(RANGE);
    expect(events).toEqual([
      {
        id: "42",
        title: "Coffee Table Talk",
        startsAt: "2026-05-28T15:00:00.000Z",
        endsAt: "2026-05-28T16:00:00.000Z",
        description: "<p>Hi</p>",
        joinLink: "https://zoom.us/j/1",
        zoomHostCode: "1234",
        slackChannelId: "C123",
      },
    ]);
  });

  it("defaults missing fragment fields to null and drops unparseable start dates", async () => {
    cmsEvents = [
      { id: "1", title: "Bare", startDateLocalized: "2026-05-28T15:00:00", endDateLocalized: "" },
      { id: "2", title: "Broken", startDateLocalized: "not-a-date", endDateLocalized: "" },
    ];
    const events = await createCmsSource(env).fetchEvents(RANGE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "1",
      endsAt: null,
      description: null,
      joinLink: null,
      zoomHostCode: null,
      slackChannelId: null,
    });
  });
});

describe("CALENDARS_QUERY", () => {
  it("requests the calendar handles", () => {
    expect(CALENDARS_QUERY).toContain("calendars");
    expect(CALENDARS_QUERY).toContain("handle");
  });
});
