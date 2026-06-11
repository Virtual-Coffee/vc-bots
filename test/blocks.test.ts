import { describe, expect, it } from "vitest";
import {
  buildDailyMessage,
  buildStartingSoonAdminMessage,
  buildStartingSoonMessage,
  buildWeeklyMessage,
} from "../src/bots/reminders/blocks";
import type { ReminderEvent } from "../src/bots/reminders/source";

const FALLBACK_CHANNEL = "C017WAKN883";

function evt(overrides: Partial<ReminderEvent> = {}): ReminderEvent {
  return {
    id: "1",
    title: "Lunch & Learn",
    startsAt: "2026-05-28T15:00:00.000Z",
    description: "<p>Bring <strong>questions</strong>!</p>",
    joinLink: "https://zoom.us/j/123",
    ...overrides,
  };
}

function json(blocks: unknown): string {
  return JSON.stringify(blocks);
}

describe("buildStartingSoonMessage", () => {
  it("renders header, title with a Join Event button for http links, description, divider", () => {
    const { text, blocks } = buildStartingSoonMessage(evt());
    expect(text).toContain("Starting soon: Lunch & Learn");
    expect(blocks[0]).toMatchObject({ type: "header", text: { text: "⏰ Starting Soon:" } });
    expect(blocks[1]).toMatchObject({
      type: "section",
      accessory: {
        type: "button",
        action_id: "button-join-event",
        value: "join_event_1",
        url: "https://zoom.us/j/123",
      },
    });
    expect(json(blocks)).toMatch(/<!date\^\d+\^\{date_long_pretty\} \{time\}\|/); // integer token
    expect(json(blocks)).toContain("*questions*"); // html → mrkdwn
    expect(json(blocks)).not.toContain("*Location:*");
    expect(blocks.at(-1)?.type).toBe("divider");
  });

  it("renders a non-http join link as a Location section instead of a button", () => {
    const { blocks } = buildStartingSoonMessage(evt({ joinLink: "The VC Lounge" }));
    expect(json(blocks)).not.toContain('"button"');
    expect(json(blocks)).toContain("*Location:* The VC Lounge");
  });

  it("omits the description context when there is no description", () => {
    const { blocks } = buildStartingSoonMessage(evt({ description: null }));
    expect(blocks.filter((b) => b.type === "context")).toHaveLength(0);
  });
});

describe("buildStartingSoonAdminMessage", () => {
  it("includes location, host code, and the target channel", () => {
    const { blocks } = buildStartingSoonAdminMessage(evt({ zoomHostCode: "9876" }), "C123");
    expect(json(blocks)).toContain("*Location:* https://zoom.us/j/123");
    expect(json(blocks)).toContain("*Host Code:* 9876");
    expect(json(blocks)).toContain("*Announcement posted to:* <#C123>");
  });

  it("omits the host code and location sections when absent", () => {
    const { blocks } = buildStartingSoonAdminMessage(
      evt({ joinLink: null, zoomHostCode: null }),
      FALLBACK_CHANNEL,
    );
    expect(json(blocks)).not.toContain("*Host Code:*");
    expect(json(blocks)).not.toContain("*Location:*");
    expect(json(blocks)).toContain(`*Announcement posted to:* <#${FALLBACK_CHANNEL}>`);
  });
});

describe("buildDailyMessage", () => {
  const events = [evt(), evt({ id: "2", title: "Coffee Chat", slackChannelId: "C555" })];

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
    const { text, blocks } = buildWeeklyMessage([
      evt(),
      evt({ id: "2", title: "Coffee Chat", slackChannelId: "C555" }),
    ]);
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
