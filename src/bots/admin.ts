import type { SlackAPIClient } from "slack-cloudflare-workers";
import type { Env } from "../env";
import { log } from "../log";
import { createSlackClient } from "../slack/client";
import { respondEphemeral } from "../slack/response";
import { adminPanelBlocks, PANEL_TEXT } from "./admin-panel";
import { homeView } from "./app-home";
import { type ReminderName, type SendResult, sendReminder } from "./reminders";
import { welcomeBlocks } from "./welcome";

/**
 * `/vc-bot-admin <type>` — manually fire auto messages. Restricted to workspace admins.
 *
 * Registered as the `.command()` lazy listener in `src/slack/app.ts`: the app ACKs Slack
 * within 3s and runs `handleAdminCommand` via `ctx.waitUntil`, so all the outbound work
 * happens after the ACK and reports back through the command's `response_url`.
 */

export const ADMIN_COMMAND = "/vc-bot-admin";

const USAGE = [
  "*`/vc-bot-admin`* — fire an auto message. Subcommands:",
  "• `daily` · `weekly` — post that event announcement now (daily also (re)schedules the starting-soon messages)",
  "• `welcome` — DM you the welcome message (preview)",
  "• `home` — publish your App Home (preview)",
  "• `coworking open` · `coworking close` — announce the co-working room",
].join("\n");

/**
 * The slash-command fields this handler reads — a structural subset of the framework's
 * `SlashCommand` payload, kept narrow so tests can construct it directly.
 */
export interface AdminCommandPayload {
  text: string;
  user_id: string;
  response_url: string;
}

/**
 * TEMPORARY: user IDs allowed to run admin commands without the workspace-admin role.
 * Remove once these users are granted Slack workspace-admin on the VC workspace.
 */
const ALLOWLISTED_ADMIN_IDS = new Set(["U031H1A1BGR"]);

export async function isWorkspaceAdmin(client: SlackAPIClient, userId: string): Promise<boolean> {
  if (ALLOWLISTED_ADMIN_IDS.has(userId)) return true;
  try {
    const res = await client.users.info({ user: userId });
    return Boolean(res.user?.is_admin || res.user?.is_owner);
  } catch {
    return false;
  }
}

export async function handleAdminCommand(cmd: AdminCommandPayload, env: Env): Promise<void> {
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
    // We're past the app's ACK (ctx.waitUntil) — an escaped rejection would be an uncaught
    // error and the admin would just see silence. Report back instead.
    log.error("admin.failed", { sub: sub ?? "(none)", err: String(err) });
    await respondEphemeral(
      cmd.response_url,
      ":warning: That failed — check the worker logs for details.",
    );
  }
}

export function reminderReply(sub: string, result: SendResult): string {
  const events = `${result.count} event${result.count === 1 ? "" : "s"}`;
  const scheduled =
    result.scheduled === undefined
      ? ""
      : ` Scheduled ${result.scheduled} starting-soon message${result.scheduled === 1 ? "" : "s"}.`;
  if (result.posted) {
    return `:white_check_mark: Posted the *${sub}* reminder (${events}).${scheduled}`;
  }
  if (result.reason === "monday") {
    return `:information_source: Skipped the *daily* summary — the weekly reminder covers Mondays.${scheduled}`;
  }
  return `:information_source: No upcoming events for the *${sub}* window — nothing posted.${scheduled}`;
}

async function runAdminCommand(
  client: SlackAPIClient,
  cmd: AdminCommandPayload,
  env: Env,
  sub: string | undefined,
  arg: string | undefined,
): Promise<void> {
  // No subcommand → show the interactive admin panel (buttons + modals). `cmd.text` of ""
  // splits to [""], so `sub` is the empty string here, not undefined.
  if (!sub) {
    await respondEphemeral(cmd.response_url, PANEL_TEXT, adminPanelBlocks());
    return;
  }

  switch (sub) {
    case "daily":
    case "weekly": {
      const result = await sendReminder(sub as ReminderName, env);
      await respondEphemeral(cmd.response_url, reminderReply(sub, result));
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
      await respondEphemeral(
        cmd.response_url,
        `Usage: \`coworking open\` or \`coworking close\`.\n\n${USAGE}`,
      );
      return;
    }

    default:
      await respondEphemeral(cmd.response_url, USAGE);
  }
}
