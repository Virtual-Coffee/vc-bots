import type { AnyMessageBlock } from "slack-web-api-client";
import type { Env } from "../env";
import { createSlackClient } from "../slack/client";
import type { SlackEvent } from "../slack/types";
import { slackUserId } from "../slack/types";

/**
 * Welcome bot — responds to the Slack `team_join` event by DMing the new member.
 *
 * Posting to a user ID opens (or reuses) the bot↔user DM, so no channel config is needed.
 */
export async function handleTeamJoin(event: SlackEvent, env: Env): Promise<void> {
  const userId = slackUserId(event.user);
  if (!userId) return;

  const client = createSlackClient(env);
  await client.chat.postMessage({
    channel: userId,
    text: "Welcome to VirtualCoffee! 👋",
    blocks: welcomeBlocks(userId),
  });
}

/**
 * Welcome message Block Kit.
 *
 * TODO(copy): replace placeholder copy/links with the real VirtualCoffee welcome content
 * (carried over from the old webhooks repo).
 */
export function welcomeBlocks(userId: string): AnyMessageBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:wave: Welcome to *VirtualCoffee*, <@${userId}>! We're so glad you're here.`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Head over to *#introductions* to say hi, and check out the *App Home* tab for what's coming up. ☕️",
      },
    },
  ];
}
