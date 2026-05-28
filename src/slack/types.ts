/**
 * Narrow types for the inbound Slack payloads we handle. Kept intentionally small —
 * extended as bots are added (welcome / App Home in Phase 3, interactivity in Phase 5).
 */

/** Events API URL handshake (sent once when configuring the request URL). */
export interface SlackUrlVerification {
  type: "url_verification";
  token: string;
  challenge: string;
}

/** Events API delivery envelope. */
export interface SlackEventCallback {
  type: "event_callback";
  team_id: string;
  api_app_id: string;
  event: SlackEvent;
}

export interface SlackEvent {
  type: string;
  user?: string | { id: string };
  [key: string]: unknown;
}

export type SlackEventsRequest = SlackUrlVerification | SlackEventCallback;

/** Interactivity (`block_actions`) payload — sent form-encoded as `payload=<json>`. */
export interface SlackBlockAction {
  action_id: string;
  block_id?: string;
  value?: string;
  type: string;
}

export interface SlackBlockActionsPayload {
  type: "block_actions";
  user: { id: string; username?: string; name?: string };
  trigger_id?: string;
  response_url: string;
  channel?: { id: string; name?: string };
  actions: SlackBlockAction[];
}

/** Slash command invocation — Slack POSTs these fields form-encoded. */
export interface SlackSlashCommand {
  command: string;
  text: string;
  user_id: string;
  channel_id: string;
  response_url: string;
  trigger_id: string;
  team_id: string;
}

/**
 * Normalize the `user` field of an event to a user ID string. Slack delivers it as a bare
 * ID (e.g. `app_home_opened`) or as a user object (e.g. `team_join`).
 */
export function slackUserId(user: SlackEvent["user"]): string | undefined {
  if (typeof user === "string") return user;
  if (user && typeof user === "object" && typeof user.id === "string") return user.id;
  return undefined;
}
