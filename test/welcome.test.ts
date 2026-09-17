import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishHomeTab, sendWelcomeDm } from "../src/bots/welcome";
import type { Env } from "../src/env";
import { installFetchRecorder, type FetchRecorder } from "./helpers/fetch-recorder";

/**
 * Unit coverage for the welcome module through its two senders: `sendWelcomeDm` (the
 * `team_join` DM) and `publishHomeTab` (the App Home tab). The Block Kit builders are private,
 * so every assertion reads the body actually posted to Slack.
 */

let fetched: FetchRecorder;

beforeEach(() => {
  fetched = installFetchRecorder();
});
afterEach(() => vi.unstubAllGlobals());

const maintainersEnv = {
  ...env,
  WELCOME_MAINTAINER_IDS: "U014HT3RNCU,U0157K5MUPJ,U01577R42TS,U01JXQGMSUC,U01B9NQF2PR",
} as Env;

interface TextBlock {
  text?: string | { text: string };
}

/** All mrkdwn/plain_text strings in the blocks, joined for content assertions. */
function allText(blocks: TextBlock[]): string {
  return blocks
    .map((b) => {
      if (!b.text) return "";
      return typeof b.text === "string" ? b.text : b.text.text;
    })
    .join("\n");
}

/** The form body of the one `chat.postMessage` a welcome DM makes. */
function postedDm(): URLSearchParams {
  const posts = fetched.callsTo("/api/chat.postMessage");
  expect(posts).toHaveLength(1);
  return fetched.form(posts[0]!);
}

function dmBlocks(): TextBlock[] {
  return JSON.parse(postedDm().get("blocks") ?? "[]");
}

describe("sendWelcomeDm", () => {
  it("DMs the user with the welcome text, no unfurls, and channel names linked", async () => {
    await sendWelcomeDm(maintainersEnv, "U123");
    const form = postedDm();
    expect(form.get("channel")).toBe("U123");
    expect(form.get("text")).toBe("👋 Welcome to Virtual Coffee!");
    expect(form.get("link_names")).toBe("true");
    expect(form.get("unfurl_links")).toBe("false");
    expect(form.get("unfurl_media")).toBe("false");
  });

  it("greets the user by mention", async () => {
    await sendWelcomeDm(maintainersEnv, "U123");
    expect(allText(dmBlocks())).toContain(":wave: Hey <@U123>, welcome to Virtual Coffee");
  });

  it("includes the Code of Conduct links", async () => {
    await sendWelcomeDm(maintainersEnv, "U123");
    const text = allText(dmBlocks());
    expect(text).toContain("https://virtualcoffee.io/code-of-conduct");
    expect(text).toContain("https://virtualcoffee.io/report-coc-violation/");
  });

  it("includes the five channel callouts", async () => {
    await sendWelcomeDm(maintainersEnv, "U123");
    const text = allText(dmBlocks());
    for (const channel of [
      "#welcome",
      "#monthly-challenge",
      "#announcements",
      "#co-working-room",
      "#help-and-pairing",
    ]) {
      expect(text).toContain(channel);
    }
  });

  it("mentions the maintainers from WELCOME_MAINTAINER_IDS as an or-list", async () => {
    await sendWelcomeDm(maintainersEnv, "U123");
    const text = allText(dmBlocks());
    expect(text).toContain("community maintainers");
    expect(text).toContain(
      "<@U014HT3RNCU>, <@U0157K5MUPJ>, <@U01577R42TS>, <@U01JXQGMSUC>, or <@U01B9NQF2PR>",
    );
  });

  it("names a lone maintainer without list punctuation", async () => {
    await sendWelcomeDm({ ...env, WELCOME_MAINTAINER_IDS: "U014HT3RNCU" }, "U123");
    const text = allText(dmBlocks());
    expect(text).toContain("community maintainers, <@U014HT3RNCU>, for any help");
    expect(text).not.toContain(", or <@");
  });

  it("omits the maintainer section when the var is empty", async () => {
    await sendWelcomeDm({ ...env, WELCOME_MAINTAINER_IDS: "" }, "U123");
    expect(allText(dmBlocks())).not.toContain("community maintainers");
  });
});

describe("publishHomeTab", () => {
  it("publishes a home view for the user that mirrors the welcome DM with the generic greeting", async () => {
    await publishHomeTab(maintainersEnv, "U123");
    const publishes = fetched.callsTo("/api/views.publish");
    expect(publishes).toHaveLength(1);
    const form = fetched.form(publishes[0]!);
    expect(form.get("user_id")).toBe("U123");
    const view = JSON.parse(form.get("view") ?? "{}");
    expect(view.type).toBe("home");

    await sendWelcomeDm(maintainersEnv, "U123");
    const dm = dmBlocks();
    expect(allText(view.blocks)).toContain(":wave: Hey there, welcome to Virtual Coffee");
    // Same content as the DM apart from the greeting: swap it in and the two are identical.
    expect(view.blocks).toEqual([
      {
        ...dm[0],
        text: {
          type: "mrkdwn",
          text: (dm[0]!.text as { text: string }).text.replace("<@U123>", "there"),
        },
      },
      ...dm.slice(1),
    ]);
  });
});
