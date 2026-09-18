import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDARS_QUERY,
  createCmsSource,
  createEventsQuery,
} from "../src/bots/reminders/sources/cms";
import { type FetchRecorder, installFetchRecorder } from "./helpers/fetch-recorder";

const RANGE = {
  rangeStart: "2026-05-28T08:00:00.000-04:00",
  rangeEnd: "2026-05-29T08:00:00.000-04:00",
};
const ZOOM = "https://us02web.zoom.us/j/81323022832?pwd=abc";

let rec: FetchRecorder;
let cmsEvents: Array<Record<string, unknown>>;

/** A minimal valid Solspace event; spread overrides on top. */
const timed = {
  title: "Coffee Table Talk",
  startDateLocalized: "2026-05-28T15:00:00", // offset-less, parsed as UTC
  endDateLocalized: "2026-05-28T16:00:00",
};

beforeEach(() => {
  cmsEvents = [];
  rec = installFetchRecorder({
    respond: (call) => {
      if (call.url !== env.CMS_GRAPHQL_URL) return undefined;
      if (call.body.includes("getCalendars")) {
        return Response.json({
          data: {
            solspace_calendar: { calendars: [{ handle: "officeHours" }, { handle: "vcEvents" }] },
          },
        });
      }
      return Response.json({ data: { solspace_calendar: { events: cmsEvents } } });
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const fetchEvents = () => createCmsSource(env).fetchEvents(RANGE);

describe("createEventsQuery", () => {
  it("builds one inline fragment per calendar handle with the custom fields", () => {
    const query = createEventsQuery(["officeHours", "vcEvents"]);
    expect(query).toContain("... on officeHours_Event");
    expect(query).toContain("... on vcEvents_Event");
    expect(query).toContain("eventCalendarDescription");
    expect(query).toContain("eventJoinLink");
    expect(query).toContain("eventZoomHostCode");
  });
});

describe("CALENDARS_QUERY", () => {
  it("requests the calendar handles", () => {
    expect(CALENDARS_QUERY).toContain("calendars");
    expect(CALENDARS_QUERY).toContain("handle");
  });
});

describe("createCmsSource — request shape", () => {
  it("fetches calendars then events with the range variables and bearer auth", async () => {
    await fetchEvents();

    const cmsCalls = rec.callsTo(env.CMS_GRAPHQL_URL);
    expect(cmsCalls).toHaveLength(2);
    expect(cmsCalls[0]!.body).toContain("getCalendars");
    expect(cmsCalls[0]!.authorization).toBe(`Bearer ${env.CMS_TOKEN}`);

    const eventsCall = JSON.parse(cmsCalls[1]!.body) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(eventsCall.query).toContain("... on officeHours_Event");
    expect(eventsCall.query).toContain("... on vcEvents_Event");
    expect(eventsCall.variables).toEqual(RANGE);
  });
});

describe("createCmsSource — mapping", () => {
  it("maps Solspace fields onto ReminderEvent: UTC instants, Markdown description, zoom join", async () => {
    cmsEvents = [
      {
        id: "42",
        ...timed,
        eventCalendarDescription: "<p>Hi <strong>there</strong></p>",
        eventJoinLink: ZOOM,
        eventZoomHostCode: " 1234 ",
      },
    ];
    expect(await fetchEvents()).toEqual([
      {
        id: "42",
        title: "Coffee Table Talk",
        startsAt: "2026-05-28T15:00:00.000Z",
        endsAt: "2026-05-28T16:00:00.000Z",
        description: "Hi **there**",
        join: { kind: "zoom", url: ZOOM, meetingId: "81323022832", hostKey: "1234" },
      },
    ]);
  });

  it("nulls missing fragment fields (join none) and drops an unparseable start date", async () => {
    cmsEvents = [
      { id: "1", title: "Bare", startDateLocalized: "2026-05-28T15:00:00", endDateLocalized: "" },
      { id: "2", title: "Broken", startDateLocalized: "not-a-date", endDateLocalized: "" },
    ];
    const events = await fetchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "1",
      endsAt: null,
      description: null,
      join: { kind: "none" },
    });
  });

  it.each([
    ["url", "https://meet.example/x", { kind: "url", url: "https://meet.example/x" }],
    ["place", "The Library, Room 4", { kind: "place", text: "The Library, Room 4" }],
  ])("%s: a non-Zoom Join Link, dropping a stray host code", async (_kind, link, join) => {
    cmsEvents = [{ id: "1", ...timed, eventJoinLink: link, eventZoomHostCode: "999" }];
    expect((await fetchEvents())[0]!.join).toEqual(join);
  });

  it("treats a blank Join Link as none", async () => {
    cmsEvents = [{ id: "1", ...timed, eventJoinLink: "   " }];
    expect((await fetchEvents())[0]!.join).toEqual({ kind: "none" });
  });

  it.each([
    ["missing", {}],
    ["blank", { eventZoomHostCode: "   " }],
  ])(
    "a Zoom event with a %s host code is dropped and alerted to #bot-log; siblings still list",
    async (_label, props) => {
      cmsEvents = [
        { id: "ev-before", ...timed, eventJoinLink: "https://meet.example/x" },
        { id: "ev-bad", ...timed, title: "Broken Zoom", eventJoinLink: ZOOM, ...props },
        { id: "ev-after", ...timed, eventJoinLink: "Somewhere" },
      ];
      const events = await fetchEvents();
      expect(events.map((e) => e.id)).toEqual(["ev-before", "ev-after"]);

      const alerts = rec.callsTo("/api/chat.postMessage");
      expect(alerts).toHaveLength(1);
      const form = rec.form(alerts[0]!);
      expect(form.get("channel")).toBe(env.SLACK_BOTLOG_CHANNEL_ID);
      expect(form.get("text")).toContain("cms.event_rejected");
      expect(form.get("text")).toContain("Broken Zoom");
      expect(form.get("text")).toContain("ev-bad");
      expect(form.get("text")).toContain("zoom-no-host-key");
      expect(form.get("text")).not.toContain("81323022832"); // no join url in the alert
    },
  );

  it("keeps an event whose description has unsupported HTML, with the tags stripped", async () => {
    cmsEvents = [
      {
        id: "1",
        ...timed,
        eventCalendarDescription: "<p>See the <table><tr><td>grid</td></tr></table> below</p>",
      },
    ];
    const events = await fetchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.description).toBe("See the grid below");
    expect(rec.callsTo("/api/chat.postMessage")).toHaveLength(0);
  });

  it("nulls an empty/whitespace description", async () => {
    cmsEvents = [{ id: "1", ...timed, eventCalendarDescription: "  " }];
    expect((await fetchEvents())[0]!.description).toBeNull();
  });
});
