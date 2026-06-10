import { describe, expect, it } from "vitest";
import { homeView } from "../src/bots/app-home";
import { welcomeBlocks } from "../src/bots/welcome";
import type { Env } from "../src/env";

const env = {
  WELCOME_MAINTAINER_IDS: "U014HT3RNCU,U0157K5MUPJ,U01577R42TS,U01JXQGMSUC,U01B9NQF2PR",
} as Env;

/** All mrkdwn/plain_text strings in the blocks, joined for content assertions. */
function allText(blocks: ReturnType<typeof welcomeBlocks>): string {
  return blocks
    .map((b) => {
      if (!("text" in b) || !b.text) return "";
      return typeof b.text === "string" ? b.text : b.text.text;
    })
    .join("\n");
}

describe("welcomeBlocks", () => {
  it("greets the user by mention when a user ID is given", () => {
    expect(allText(welcomeBlocks(env, "U123"))).toContain(":wave: Hey <@U123>, welcome to Virtual Coffee");
  });

  it("falls back to a generic greeting without a user ID", () => {
    expect(allText(welcomeBlocks(env))).toContain(":wave: Hey there, welcome to Virtual Coffee");
  });

  it("includes the Code of Conduct links", () => {
    const text = allText(welcomeBlocks(env, "U123"));
    expect(text).toContain("https://virtualcoffee.io/code-of-conduct");
    expect(text).toContain("https://virtualcoffee.io/report-coc-violation/");
  });

  it("includes the five channel callouts", () => {
    const text = allText(welcomeBlocks(env, "U123"));
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

  it("mentions the maintainers from WELCOME_MAINTAINER_IDS", () => {
    const text = allText(welcomeBlocks(env, "U123"));
    expect(text).toContain("community maintainers");
    expect(text).toContain("<@U014HT3RNCU>, <@U0157K5MUPJ>, <@U01577R42TS>, <@U01JXQGMSUC>, or <@U01B9NQF2PR>");
  });

  it("omits the maintainer section when the var is empty", () => {
    const text = allText(welcomeBlocks({ WELCOME_MAINTAINER_IDS: "" } as Env, "U123"));
    expect(text).not.toContain("community maintainers");
  });
});

describe("homeView", () => {
  it("mirrors the welcome blocks with the generic greeting", () => {
    const view = homeView(env);
    expect(view.type).toBe("home");
    expect(view.blocks).toEqual(welcomeBlocks(env));
  });
});
