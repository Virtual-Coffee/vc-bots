import { describe, expect, it, vi } from "vitest";

// Mock the bot handlers so we test ONLY the dispatch routing, not Slack I/O.
vi.mock("../src/bots/welcome", () => ({ handleTeamJoin: vi.fn(async () => {}) }));
vi.mock("../src/bots/app-home", () => ({ handleAppHomeOpened: vi.fn(async () => {}) }));

import { handleAppHomeOpened } from "../src/bots/app-home";
import { dispatchSlackEvent } from "../src/bots/slack-events";
import { handleTeamJoin } from "../src/bots/welcome";
import type { Env } from "../src/env";

const env = {} as Env;

describe("dispatchSlackEvent", () => {
  it("routes team_join to the welcome handler", async () => {
    const event = { type: "team_join", user: { id: "U123" } };
    await dispatchSlackEvent(event, env);
    expect(handleTeamJoin).toHaveBeenCalledWith(event, env);
    expect(handleAppHomeOpened).not.toHaveBeenCalled();
  });

  it("routes app_home_opened to the App Home handler", async () => {
    const event = { type: "app_home_opened", user: "U456" };
    await dispatchSlackEvent(event, env);
    expect(handleAppHomeOpened).toHaveBeenCalledWith(event, env);
  });

  it("ignores unknown event types", async () => {
    await expect(dispatchSlackEvent({ type: "message" }, env)).resolves.toBeUndefined();
  });
});
