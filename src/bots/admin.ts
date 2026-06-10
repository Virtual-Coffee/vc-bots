import type { SlackAPIClient } from "slack-web-api-client";
import type { Env } from "../env";
import { log } from "../log";
import { createSlackClient } from "../slack/client";
import { respondEphemeral } from "../slack/response";
import type { SlackSlashCommand } from "../slack/types";
import { homeView } from "./app-home";
import { REMINDER_KINDS, type ReminderName, sendReminder } from "./reminders";
import { welcomeBlocks } from "./welcome";

/**
 * `/vc-bot-admin <type>` — manually fire auto messages. Restricted to workspace admins.
 *
 * The route ACKs Slack within 3s and calls `handleAdminCommand` via `ctx.waitUntil`, so all the
 * outbound work happens after the ACK and reports back through the command's `response_url`.
 */

export const ADMIN_COMMAND = "/vc-bot-admin";

const USAGE = [
  "*`/vc-bot-admin`* — fire an auto message. Subcommands:",
  "• `hourly` · `daily` · `weekly` — post that event reminder now",
  "• `welcome` — DM you the welcome message (preview)",
  "• `home` — publish your App Home (preview)",
  "• `coworking open` · `coworking close` — announce the co-working room",
  "• `coworking invite` — post the 'start a session' invite to the co-working channel",
].join("\n");

/** Parse the form-encoded slash-command body into a typed payload. */
export function parseSlashCommand(form: URLSearchParams): SlackSlashCommand | null {
  const command = form.get("command");
  const user_id = form.get("user_id");
  const response_url = form.get("response_url");
  if (!command || !user_id || !response_url) return null;
  return {
    command,
    text: form.get("text") ?? "",
    user_id,
    channel_id: form.get("channel_id") ?? "",
    response_url,
    trigger_id: form.get("trigger_id") ?? "",
    team_id: form.get("team_id") ?? "",
  };
}

async function isWorkspaceAdmin(client: SlackAPIClient, userId: string): Promise<boolean> {
  try {
    const res = await client.users.info({ user: userId });
    return Boolean(res.user?.is_admin || res.user?.is_owner);
  } catch {
    return false;
  }
}

export async function handleAdminCommand(cmd: SlackSlashCommand, env: Env): Promise<void> {
  const client = createSlackClient(env);

  if (!(await isWorkspaceAdmin(client, cmd.user_id))) {
    log.warn("admin.denied", { user: cmd.user_id, text: cmd.text });
    await respondEphemeral(cmd.response_url, ":no_entry: This command is for workspace admins only.");
    return;
  }

  const [sub, arg] = cmd.text.trim().split(/\s+/);

  try {
    await runAdminCommand(client, cmd, env, sub, arg);
  } catch (err) {
    // We're past the route's ACK (ctx.waitUntil) — an escaped rejection would be an uncaught
    // error and the admin would just see silence. Report back instead.
    log.error("admin.failed", { sub: sub ?? "(none)", err: String(err) });
    await respondEphemeral(
      cmd.response_url,
      ":warning: That failed — check the worker logs for details.",
    );
  }
}

async function runAdminCommand(
  client: SlackAPIClient,
  cmd: SlackSlashCommand,
  env: Env,
  sub: string | undefined,
  arg: string | undefined,
): Promise<void> {
  switch (sub) {
    case "hourly":
    case "daily":
    case "weekly": {
      const { posted, count } = await sendReminder(REMINDER_KINDS[sub as ReminderName], env);
      await respondEphemeral(
        cmd.response_url,
        posted
          ? `:white_check_mark: Posted the *${sub}* reminder (${count} event${count === 1 ? "" : "s"}).`
          : `:information_source: No upcoming events for the *${sub}* window — nothing posted.`,
      );
      return;
    }

    case "welcome": {
      await client.chat.postMessage({
        channel: cmd.user_id,
        text: "Welcome message preview",
        blocks: welcomeBlocks(env, cmd.user_id),
        link_names: true,
        unfurl_links: false,
        unfurl_media: false,
      });
      await respondEphemeral(cmd.response_url, ":white_check_mark: Sent you the welcome message.");
      return;
    }

    case "home":
    case "app-home": {
      await client.views.publish({ user_id: cmd.user_id, view: homeView(env) });
      await respondEphemeral(cmd.response_url, ":white_check_mark: Published your App Home.");
      return;
    }

    case "coworking": {
      const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
      if (arg === "open") {
        await stub.adminAnnounceOpen();
        await respondEphemeral(cmd.response_url, ":white_check_mark: Posted the co-working room-open announcement.");
        return;
      }
      if (arg === "close") {
        const { closed } = await stub.adminAnnounceClose();
        await respondEphemeral(
          cmd.response_url,
          closed
            ? ":white_check_mark: Closed the co-working announcement."
            : ":information_source: No open announcement to close.",
        );
        return;
      }
      if (arg === "invite") {
        await stub.adminPostInvite();
        await respondEphemeral(cmd.response_url, ":white_check_mark: Posted the co-working invite.");
        return;
      }
      await respondEphemeral(
        cmd.response_url,
        `Usage: \`coworking open\`, \`coworking close\`, or \`coworking invite\`.\n\n${USAGE}`,
      );
      return;
    }

    default:
      await respondEphemeral(cmd.response_url, USAGE);
  }
}
