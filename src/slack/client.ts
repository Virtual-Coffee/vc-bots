import { SlackAPIClient } from "slack-web-api-client";
import type { Env } from "../env";

/**
 * Factory for the Slack Web API client (fetch-based, edge-native).
 *
 * All outbound Slack calls (`chat.*`, `views.*`, `users.*`) go through this.
 */
export function createSlackClient(env: Env): SlackAPIClient {
  return new SlackAPIClient(env.SLACK_BOT_TOKEN);
}
