import type { Env } from "../../env";
import { respondEphemeral } from "../../slack/response";
import { EVENT_SOURCE_NAMES, type ReminderName, isEventSourceName } from "../reminders";
import { type AdminAction, adminReplyText, guardAdmin, runAdminAction } from "./actions";
import { adminPanelBlocks, PANEL_TEXT } from "./panel";

/**
 * `/vc-bot-admin <type>` — manually fire auto messages. Restricted to workspace admins.
 *
 * Registered as the `.command()` lazy listener in `src/slack/app.ts`: the app ACKs Slack
 * within 3s and runs `handleAdminCommand` via `ctx.waitUntil`, so all the outbound work
 * happens after the ACK and reports back through the command's `response_url`.
 *
 * This is the text adapter over `actions.ts`: parse the command into an `AdminAction`, run it,
 * reply with `adminReplyText`. Only the parse replies (panel, usage, unknown source) are gated
 * here; an action is gated by `runAdminAction`.
 */

export const ADMIN_COMMAND = "/vc-bot-admin";

const USAGE = [
  "*`/vc-bot-admin`* — fire an auto message. Subcommands:",
  "• `daily [source]` · `weekly [source]` — post that event announcement now (source: google; default from config; daily also (re)schedules the starting-soon messages)",
  "• `welcome [@user]` — DM the welcome message to you (preview) or to the mentioned member",
  "• `home` — publish your App Home (preview)",
  "• `coworking open` · `coworking close` — announce the co-working room",
  "• `watch status` · `watch start` · `watch stop` — the Google Calendar watch channel",
].join("\n");

/**
 * A welcome target as Slack hands it to a slash command: a mention (`<@U123|name>` /
 * `<@U123>`) or a bare user id. Captures the id.
 */
const USER_ARG = /^(?:<@([UW][A-Z0-9]+)(?:\|[^>]*)?>|([UW][A-Z0-9]+))$/;

/**
 * The slash-command fields this handler reads — a structural subset of the framework's
 * `SlashCommand` payload, kept narrow so tests can construct it directly.
 */
export interface AdminCommandPayload {
  text: string;
  user_id: string;
  response_url: string;
}

type ParsedCommand =
  | { kind: "panel" }
  | { kind: "reply"; text: string }
  | { kind: "action"; action: AdminAction };

export async function handleAdminCommand(cmd: AdminCommandPayload, env: Env): Promise<void> {
  const parsed = parseAdminCommand(cmd.text, cmd.user_id);

  if (parsed.kind === "action") {
    const result = await runAdminAction(env, cmd.user_id, parsed.action);
    // The slash surface addresses the invoker directly when the DM went to them.
    const text =
      result.kind === "welcome" && result.target === cmd.user_id
        ? ":white_check_mark: Sent you the welcome message."
        : adminReplyText(result);
    await respondEphemeral(cmd.response_url, text);
    return;
  }

  if (!(await guardAdmin(env, cmd.user_id, { text: cmd.text }))) {
    await respondEphemeral(cmd.response_url, adminReplyText({ kind: "denied" }));
    return;
  }
  if (parsed.kind === "panel") {
    await respondEphemeral(cmd.response_url, PANEL_TEXT, adminPanelBlocks());
    return;
  }
  await respondEphemeral(cmd.response_url, parsed.text);
}

function parseAdminCommand(text: string, userId: string): ParsedCommand {
  const [sub, arg] = text.trim().split(/\s+/);

  // No subcommand → show the interactive admin panel (buttons + modals). A `text` of ""
  // splits to [""], so `sub` is the empty string here, not undefined.
  if (!sub) return { kind: "panel" };

  switch (sub) {
    case "daily":
    case "weekly": {
      if (arg !== undefined && !isEventSourceName(arg)) {
        const list = EVENT_SOURCE_NAMES.map((n) => `\`${n}\``).join(", ");
        return { kind: "reply", text: `:warning: Unknown event source \`${arg}\`. Valid sources: ${list}` };
      }
      return {
        kind: "action",
        action: { kind: "reminder", name: sub as ReminderName, nowMs: Date.now(), source: arg },
      };
    }

    case "welcome": {
      if (arg === undefined) return { kind: "action", action: { kind: "welcome", target: userId } };
      // The rest of the line, not just `arg`: an escaped mention's display name may hold spaces.
      const match = USER_ARG.exec(text.trim().slice(sub.length).trim());
      const target = match?.[1] ?? match?.[2];
      if (!target) {
        return { kind: "reply", text: `Usage: \`welcome\` or \`welcome @user\`.\n\n${USAGE}` };
      }
      return { kind: "action", action: { kind: "welcome", target } };
    }

    case "home":
    case "app-home":
      return { kind: "action", action: { kind: "home", userId } };

    case "coworking": {
      if (arg === "open" || arg === "close") {
        return { kind: "action", action: { kind: "coworking", op: arg } };
      }
      return { kind: "reply", text: `Usage: \`coworking open\` or \`coworking close\`.\n\n${USAGE}` };
    }

    case "watch": {
      if (arg === "status" || arg === "start" || arg === "stop") {
        return { kind: "action", action: { kind: "watch", op: arg } };
      }
      return {
        kind: "reply",
        text: `Usage: \`watch status\`, \`watch start\` or \`watch stop\`.\n\n${USAGE}`,
      };
    }

    default:
      return { kind: "reply", text: USAGE };
  }
}
