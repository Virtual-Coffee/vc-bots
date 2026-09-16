import { describe, expect, it } from "vitest";
import { buildDailyMessage, buildWeeklyMessage } from "../src/bots/reminders/blocks";
import type { ReminderEvent } from "../src/bots/reminders/source";

function evt(overrides: Partial<ReminderEvent> = {}): ReminderEvent {
  return {
    id: "1",
    title: "Lunch & Learn",
    startsAt: "2026-05-28T15:00:00.000Z",
    description: "Bring **questions**!",
    joinLink: "https://zoom.us/j/123",
    hostKey: "9876",
    ...overrides,
  };
}

function json(blocks: unknown): string {
  return JSON.stringify(blocks);
}

describe("buildDailyMessage", () => {
  const events = [evt(), evt({ id: "2", title: "Coffee Chat" })];

  it("renders the header, per-event sections without buttons, and join-link notices", () => {
    const { text, blocks } = buildDailyMessage(events);
    expect(text).toContain("Today's events are: Lunch & Learn");
    expect(blocks[0]).toMatchObject({ type: "header", text: { text: "📆 Today's Events Are:" } });
    expect(json(blocks)).not.toContain('"button"'); // no Join buttons in the summary
    expect(json(blocks)).toContain("Link to join will be posted about 10 minutes before");
    expect(json(blocks)).not.toContain("<#"); // no channel mentions in the announcement
  });

  it("omits empty description contexts (Slack rejects empty context elements)", () => {
    const { blocks } = buildDailyMessage([evt({ description: "" })]);
    const contexts = blocks.filter((b) => b.type === "context");
    expect(json(contexts)).toContain("Link to join");
    expect(contexts).toHaveLength(1); // only the join-link notice
  });
});

describe("buildWeeklyMessage", () => {
  it("renders one date-first section per event plus the footer contexts", () => {
    const { text, blocks } = buildWeeklyMessage([evt(), evt({ id: "2", title: "Coffee Chat" })]);
    expect(text).toContain("This weeks events are:");
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { text: "📆 This Week's Events Are:" },
    });
    expect(json(blocks)).toMatch(/\*<!date\^\d+\^[^>]+>\*\\nLunch & Learn/);
    expect(json(blocks)).not.toContain("<#"); // no channel mentions in the announcement
    expect(json(blocks)).toContain("Links to join will be posted about 10 minutes before");
    expect(json(blocks)).toContain("<https://virtualcoffee.io/events|VirtualCoffee.IO>");
  });
});
