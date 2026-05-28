import type { AnyHomeTabBlock, HomeTabView } from "slack-web-api-client";
import type { Env } from "../env";
import { createSlackClient } from "../slack/client";
import type { SlackEvent } from "../slack/types";
import { slackUserId } from "../slack/types";

/**
 * App Home bot — responds to `app_home_opened` by publishing the Home tab view.
 */
export async function handleAppHomeOpened(event: SlackEvent, env: Env): Promise<void> {
  const userId = slackUserId(event.user);
  if (!userId) return;

  const client = createSlackClient(env);
  await client.views.publish({ user_id: userId, view: homeView(env) });
}

/**
 * Home tab view.
 *
 * TODO(copy): flesh out with the real VirtualCoffee Home content (links, upcoming events,
 * quick actions). Kept minimal for parity in Phase 3.
 */
export function homeView(_env: Env): HomeTabView {
  const blocks: AnyHomeTabBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Welcome to VirtualCoffee ☕️", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "A community of developers supporting each other. Jump into the *#co-working-room*, share a win in *#wins*, or browse upcoming events.",
      },
    },
    { type: "divider" },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Made with :coffee: by the VirtualCoffee bots." }],
    },
  ];
  return { type: "home", blocks };
}
