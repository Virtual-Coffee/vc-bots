import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  ALL_THE_THINGS_REACTION,
  buildDayMessage,
  buildIntroMessage,
  emptySheet,
  OUT_REACTION,
  ROLES,
  SEED_REACTIONS,
  sheetFromReactions,
  weekDays,
} from "../src/bots/availability/message";

/** Pure layout + projection suite for the availability check-in messages. */

const BOT = "UBOT";

type Blocks = ReturnType<typeof buildIntroMessage>["blocks"];

/** Every block's text, one entry per block, so tests can address blocks by position. */
function mrkdwn(blocks: Blocks): string[] {
  return blocks.map((b) => {
    if (b.type === "section" && b.text) return b.text.text;
    if (b.type === "section" && b.fields) return b.fields.map((f) => f.text).join("\n");
    if (b.type === "context") return b.elements.map((e) => ("text" in e ? e.text : "")).join("");
    if (b.type === "header") return b.text.text;
    return "";
  });
}

describe("ROLES and seed reactions", () => {
  it("seeds the four role emoji and :x:, never :all-the-things:", () => {
    expect(SEED_REACTIONS).toEqual([...ROLES.map((r) => r.reaction), OUT_REACTION]);
    expect(SEED_REACTIONS).not.toContain(ALL_THE_THINGS_REACTION);
  });
});

describe("buildIntroMessage", () => {
  it("titles the ask, pings the channel, lays the legend out as a fields grid, and hints at the day messages", () => {
    const { text, blocks } = buildIntroMessage();
    const rendered = mrkdwn(blocks);

    expect(blocks.map((b) => b.type)).toEqual([
      "header",
      "section",
      "section",
      "divider",
      "context",
    ]);
    expect(rendered[0]).toBe(":spiral_calendar_pad: Who can help out this week?");
    expect(text).toContain("<!channel>");
    expect(rendered[1]).toContain("<!channel> Hey friends");

    const legend = blocks[2];
    expect(legend?.type === "section" && legend.fields?.map((f) => f.text)).toEqual([
      ":computer: *Host*",
      ":microphone: *MC*",
      ":memo: *Notetaker*",
      ":speech_balloon: *Room leader*",
      ":x: *Unavailable*",
    ]);
    expect(rendered[2]).not.toContain(ALL_THE_THINGS_REACTION);
    expect(rendered[4]).toBe(
      ":point_down: Sign up by reacting on a day message — the lists there update themselves.",
    );
  });
});

describe("buildDayMessage", () => {
  const date = DateTime.fromISO("2026-09-15T12:00", { zone: "America/New_York" });

  it("headers the day and date, dashes every empty role, says nobody is out yet, and carries the hint", () => {
    const { text, blocks } = buildDayMessage("tuesday", date, emptySheet());
    const rendered = mrkdwn(blocks);

    expect(blocks.map((b) => b.type)).toEqual([
      "header",
      "section",
      "divider",
      "context",
      "context",
    ]);
    expect(rendered[0]).toBe("Tuesday · Sep 15");
    expect(text).toContain("Tuesday · Sep 15");
    expect(rendered[1]).toBe(
      [
        ":computer: *Host:* —",
        ":microphone: *MC:* —",
        ":memo: *Notetaker:* —",
        ":speech_balloon: *Room leader:* —",
      ].join("\n"),
    );
    expect(rendered[3]).toBe(":x: Out Tuesday: nobody yet");
    expect(rendered[4]).toBe(
      "Tap a reaction to sign up · remove it to withdraw · :x: if you're out",
    );
  });

  it("lists sign-ups as mentions in reaction order under their role and the out people on their own line", () => {
    const sheet = { ...emptySheet(), out: ["U3", "U4"] };
    sheet.roles.host = ["U1", "U2"];
    const rendered = mrkdwn(buildDayMessage("thursday", date.plus({ days: 2 }), sheet).blocks);

    expect(rendered[1]).toContain(":computer: *Host:* <@U1>, <@U2>");
    expect(rendered[1]).toContain(":microphone: *MC:* —");
    expect(rendered[1]).not.toContain("Unavailable");
    expect(rendered[3]).toBe(":x: Out Thursday: <@U3>, <@U4>");
  });
});

describe("sheetFromReactions", () => {
  it("projects each role's reactors, dropping the bot's seed and ignoring unknown reactions", () => {
    const sheet = sheetFromReactions(
      [
        { name: "computer", users: [BOT, "U1", "U2"] },
        { name: "microphone", users: [BOT] },
        { name: "memo", users: ["U3", BOT] },
        { name: "speech_balloon", users: ["U2"] },
        { name: "x", users: [BOT, "U4"] },
        { name: "tada", users: ["U5"] },
      ],
      BOT,
    );

    expect(sheet).toEqual({
      roles: { host: ["U1", "U2"], mc: [], notetaker: ["U3"], roomLeader: ["U2"] },
      out: ["U4"],
    });
  });

  it(":x: wins — someone who is out is dropped from every role even though their reactions remain", () => {
    const sheet = sheetFromReactions(
      [
        { name: "computer", users: ["U1", "U2"] },
        { name: "memo", users: ["U2"] },
        { name: ALL_THE_THINGS_REACTION, users: ["U2"] },
        { name: "x", users: ["U2"] },
      ],
      BOT,
    );

    expect(sheet).toEqual({
      roles: { host: ["U1"], mc: [], notetaker: [], roomLeader: [] },
      out: ["U2"],
    });
  });

  it(":all-the-things: signs the reactor up for every role, after the direct reactors, once", () => {
    const sheet = sheetFromReactions(
      [
        { name: "computer", users: ["U9", "U1"] },
        { name: "memo", users: ["U2"] },
        { name: ALL_THE_THINGS_REACTION, users: [BOT, "U9", "U8"] },
      ],
      BOT,
    );

    expect(sheet).toEqual({
      roles: {
        host: ["U9", "U1", "U8"],
        mc: ["U9", "U8"],
        notetaker: ["U2", "U9", "U8"],
        roomLeader: ["U9", "U8"],
      },
      out: [],
    });
  });

  it("is empty for a message with no reactions", () => {
    expect(sheetFromReactions(undefined, BOT)).toEqual(emptySheet());
  });
});

describe("weekDays", () => {
  it("returns this week's Tuesday and Thursday in Eastern time, whichever weekday it is", () => {
    const monday = Date.parse("2026-09-14T13:00:00Z");
    const wednesday = Date.parse("2026-09-16T20:00:00Z");

    for (const now of [monday, wednesday]) {
      const days = weekDays(now);
      expect(days.tuesday.toISODate()).toBe("2026-09-15");
      expect(days.thursday.toISODate()).toBe("2026-09-17");
    }
  });
});
