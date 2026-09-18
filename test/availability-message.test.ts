import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  buildDayMessage,
  buildIntroMessage,
  emptySheet,
  ROLES,
  sheetFromReactions,
  weekDays,
} from "../src/bots/availability/message";

/** Pure layout + projection suite for the availability check-in messages. */

const BOT = "UBOT";

function mrkdwn(blocks: ReturnType<typeof buildIntroMessage>["blocks"]): string[] {
  return blocks.flatMap((b) => {
    if (b.type === "section" && b.text) return [b.text.text];
    if (b.type === "context") return b.elements.map((e) => ("text" in e ? e.text : ""));
    if (b.type === "header") return [b.text.text];
    return [];
  });
}

describe("buildIntroMessage", () => {
  it("pings the channel, lists all five roles with their emoji codes, and hints at the day messages", () => {
    const { text, blocks } = buildIntroMessage();
    const rendered = mrkdwn(blocks);

    expect(text).toContain("<!channel>");
    expect(rendered[0]).toContain("<!channel> Hey friends");
    for (const { label, reaction } of ROLES) {
      expect(rendered[1]).toContain(`• ${label}: :${reaction}: (\`:${reaction}:\`)`);
    }
    expect(rendered[2]).toContain("the lists update automatically");
  });
});

describe("buildDayMessage", () => {
  const date = DateTime.fromISO("2026-09-15T12:00", { zone: "America/New_York" });

  it("headers the day and date, renders a dash for every empty role, and carries the un-sign hint", () => {
    const { text, blocks } = buildDayMessage("tuesday", date, emptySheet());
    const rendered = mrkdwn(blocks);

    expect(rendered[0]).toBe("Tuesday · Sep 15");
    expect(text).toContain("Tuesday · Sep 15");
    for (const { label, reaction } of ROLES) {
      expect(rendered[1]).toContain(`:${reaction}: *${label}:* —`);
    }
    expect(rendered[2]).toContain("remove it to un-sign");
  });

  it("lists sign-ups as mentions in reaction order under their role", () => {
    const sheet = { ...emptySheet(), host: ["U1", "U2"], unavailable: ["U3"] };
    const [, section] = mrkdwn(buildDayMessage("thursday", date.plus({ days: 2 }), sheet).blocks);

    expect(section).toContain(":computer: *Host:* <@U1>, <@U2>");
    expect(section).toContain(":x: *Unavailable:* <@U3>");
    expect(section).toContain(":microphone: *MC:* —");
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
        { name: "x", users: ["U4"] },
        { name: "tada", users: ["U5"] },
      ],
      BOT,
    );

    expect(sheet).toEqual({
      host: ["U1", "U2"],
      mc: [],
      notetaker: ["U3"],
      roomLeader: ["U2"],
      unavailable: ["U4"],
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
