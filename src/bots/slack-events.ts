import type { Env } from "../env";
import type { SlackEvent } from "../slack/types";
import { handleAppHomeOpened } from "./app-home";
import { handleTeamJoin } from "./welcome";

/**
 * Dispatch an inbound Slack Events API event to the owning bot. Called from the
 * `/slack/events` route AFTER the 200 ACK (via `ctx.waitUntil`), so Slack's 3s window is
 * never blocked by outbound work.
 */
export async function dispatchSlackEvent(event: SlackEvent, env: Env): Promise<void> {
  switch (event.type) {
    case "team_join":
      return handleTeamJoin(event, env);
    case "app_home_opened":
      return handleAppHomeOpened(event, env);
    default:
      return;
  }
}
