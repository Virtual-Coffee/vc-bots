import { describe, expect, it } from "vitest";
import {
  buildChangeNotice,
  buildDailyMessage,
  buildWeeklyMessage,
} from "../src/bots/reminders/blocks";
import type { ReminderEvent } from "../src/events";

function evt(overrides: Partial<ReminderEvent> = {}): ReminderEvent {
  return {
    id: "1",
    title: "Lunch & Learn",
    startsAt: "2026-05-28T15:00:00.000Z",
    description: "Bring **questions**!",
    join: { kind: "zoom", url: "https://zoom.us/j/123", meetingId: "123", hostKey: "9876" },
    ...overrides,
  };
}

function json(blocks: unknown): string {
  return JSON.stringify(blocks);
}

describe("buildDailyMessage", () => {
  const events = [evt(), evt({ id: "2", title: "Coffee Chat" })];

  it("renders the header, per-event sections without buttons, and join-link notices", () => {
    const { text, blocks } = buildDailyMessage(events, "C0EVENTS");
    expect(text).toContain("Today's events are: Lunch & Learn");
    expect(text).toContain("posted in <#C0EVENTS>");
    expect(blocks[0]).toMatchObject({ type: "header", text: { text: "📆 Today's Events Are:" } });
    expect(json(blocks)).not.toContain('"button"'); // no Join buttons in the summary
    expect(json(blocks)).toContain(
      "Link to join will be posted in <#C0EVENTS> about 10 minutes before",
    );
  });

  it("omits empty description contexts (Slack rejects empty context elements)", () => {
    const { blocks } = buildDailyMessage([evt({ description: "" })], "C0EVENTS");
    const contexts = blocks.filter((b) => b.type === "context");
    expect(json(contexts)).toContain("Link to join");
    expect(contexts).toHaveLength(1); // only the join-link notice
  });
});

describe("buildWeeklyMessage", () => {
  it("renders one date-first section per event plus the footer contexts", () => {
    const { text, blocks } = buildWeeklyMessage(
      [evt(), evt({ id: "2", title: "Coffee Chat" })],
      "C0EVENTS",
    );
    expect(text).toContain("This weeks events are:");
    expect(text).toContain("posted in <#C0EVENTS>");
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { text: "📆 This Week's Events Are:" },
    });
    expect(json(blocks)).toMatch(/\*<!date\^\d+\^[^>]+>\*\\nLunch & Learn/);
    expect(json(blocks)).toContain(
      "Links to join will be posted in <#C0EVENTS> about 10 minutes before",
    );
    expect(json(blocks)).toContain("<https://virtualcoffee.io/events|VirtualCoffee.IO>");
  });
});

describe("buildChangeNotice", () => {
  const startSecs = (iso: string) => Date.parse(iso) / 1000;
  const sectionTexts = (message: ReturnType<typeof buildChangeNotice>) =>
    (message.attachments?.[0]?.blocks ?? []).map(
      (b) => (b as { text: { text: string } }).text.text,
    );

  it("renders a cancelled change as a standout attachment", () => {
    const message = buildChangeNotice({ kind: "cancelled", event: evt() });
    expect(message.text).toMatch(/^Cancelled: Lunch & Learn — /);
    expect(message.blocks).toEqual([]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments![0]!.color).toBe("#d9376e");
    const [headerText, titleText, body] = sectionTexts(message);
    expect(headerText).toBe("*:warning: Event Cancelled*");
    expect(titleText).toContain(`*Lunch & Learn*\n<!date^${startSecs(evt().startsAt)}^`);
    expect(body).toBe("This event has been cancelled.");
  });

  it("renders a rescheduled change with the old and new start", () => {
    const message = buildChangeNotice({
      kind: "rescheduled",
      event: evt(),
      from: "2026-05-27T15:00:00.000Z",
    });
    expect(message.text).toMatch(/^Rescheduled: Lunch & Learn — now /);
    expect(message.blocks).toEqual([]);
    expect(message.attachments![0]!.color).toBe("#d9376e");
    const [headerText, titleText, was, now] = sectionTexts(message);
    expect(headerText).toBe("*:calendar: Event Rescheduled*");
    expect(titleText).toBe("*Lunch & Learn*");
    expect(was).toContain(`*Was:* <!date^${startSecs("2026-05-27T15:00:00.000Z")}^`);
    expect(now).toContain(`*Now:* <!date^${startSecs(evt().startsAt)}^`);
  });
});
