import { describe, expect, it } from "vitest";
import { buildReminderMessage } from "../src/bots/reminders/blocks";
import type { CmsEvent } from "../src/bots/reminders/cms";

// welcomeBlocks / homeView are covered in test/welcome.test.ts.

describe("buildReminderMessage", () => {
  const events: CmsEvent[] = [
    {
      id: "1",
      title: "Lunch & Learn",
      startsAt: "2026-05-28T15:00:00Z",
      url: "https://vc.io/e/1",
      description: "<p>Bring <strong>questions</strong>!</p>",
    },
    { id: "2", title: "Coffee Chat", startsAt: "2026-05-28T16:00:00Z" },
  ];

  it("builds a header + one section per event", () => {
    const { text, blocks } = buildReminderMessage("Today at VirtualCoffee", events);
    expect(text).toContain("2 events");
    expect(blocks[0]?.type).toBe("header");
    expect(blocks.filter((b) => b.type === "section")).toHaveLength(2);
  });

  it("links titles, renders a per-viewer date token, and slackifies HTML descriptions", () => {
    const { blocks } = buildReminderMessage("Today", events);
    const json = JSON.stringify(blocks);
    expect(json).toContain("<https://vc.io/e/1|Lunch & Learn>");
    expect(json).toContain("<!date^"); // per-viewer date token
    expect(json).toContain("*questions*"); // slackify-html: <strong> → *…*
  });

  it("handles the singular event count", () => {
    const { text } = buildReminderMessage("Soon", [events[0]!]);
    expect(text).toContain("1 event");
    expect(text).not.toContain("1 events");
  });
});
