import { SlackAPIClient } from "slack-web-api-client";
import type { Env } from "../env";

/**
 * Factory for the Slack Web API client (fetch-based, edge-native).
 *
 * All outbound Slack calls (`chat.*`, `views.*`, `users.*`, and — via the generic
 * `client.call("calls.*", …)` escape hatch in Phase 5 — `calls.*`) go through this.
 */
export function createSlackClient(env: Env): SlackAPIClient {
  return new SlackAPIClient(env.SLACK_BOT_TOKEN);
}
