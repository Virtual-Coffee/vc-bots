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
    text: "👋 Welcome to Virtual Coffee!",
    blocks: welcomeBlocks(env, userId),
    link_names: true,
    unfurl_links: false,
    unfurl_media: false,
  });
}

/** A blank section the old bot used to add breathing room around dividers. */
function spacer(): AnyMessageBlock {
  return { type: "section", text: { type: "mrkdwn", text: " " } };
}

/**
 * Welcome message Block Kit, shared by the `team_join` DM and the App Home tab
 * (which passes no user). Content ported from the old webhooks repo.
 */
export function welcomeBlocks(env: Env, userId?: string): AnyMessageBlock[] {
  const blocks: AnyMessageBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:wave: Hey ${
          userId ? `<@${userId}>` : "there"
        }, welcome to Virtual Coffee -- fondly referred to as VC around this space.`,
      },
    },
    spacer(),
    { type: "divider" },
    spacer(),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":heart: Before doing anything else, please first take a moment to read our <https://virtualcoffee.io/code-of-conduct|Code of Conduct>. Our Code of Conduct is in effect at any Virtual Coffee function, including direct messages. If you have experienced or witnessed violations to Virtual Coffee's Code of Conduct, please use our <https://virtualcoffee.io/report-coc-violation/|Code of Conduct Violation Form> to let us know.",
      },
    },
    spacer(),
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "Now for the fun part!", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "We have a lot going on here, but here are some places you might want to start:",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":white_check_mark: Head over to #welcome and introduce yourself to the rest of the group! Let us know what you like to do in your freetime, what you're doing in tech, and a random fact about your life!",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":dart: Check out #monthly-challenge to see what the community is working on together right now.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":mega: The #announcements channel has the most recent news on events and initiatives happening in the community.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":computer: Our #co-working-room is a zoom room that's open all day, every day for members to quietly work, pair on solving problems, or just say hello.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":question: #help-and-pairing is the space for asking questions about any and all tech related topics. But if you have a general question, we have a really welcoming community, so feel free to throw it in the channel that looks best.",
      },
    },
  ];

  const maintainers = (env.WELCOME_MAINTAINER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (maintainers.length > 0) {
    const mentions = maintainers.map((id) => `<@${id}>`);
    const list =
      mentions.length > 1
        ? `${mentions.slice(0, -1).join(", ")}, or ${mentions.at(-1)}`
        : mentions[0];
    blocks.push(spacer(), { type: "divider" }, spacer(), {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:heart: And remember, you can always message one of our community maintainers, ${list}, for any help and support you may need. \n\n *We're happy to have you here!*`,
      },
    });
  }

  return blocks;
}
