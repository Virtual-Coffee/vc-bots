import type { Env } from "../../env";
import { log } from "../../log";
import { reportFailure } from "../../slack/notify";
import { respondEphemeral } from "../../slack/response";

/**
 * `/coworking-react` — a member picks the join reaction the bot adds to the room message each
 * time they join a session. Registered as the `.command()` lazy listener in `src/slack/app.ts`;
 * the preference lives in the co-working DO's `reaction_pref` table, and the DO adds the
 * reaction when a correlated member joins (`CoworkingRoom.recordJoin`).
 *
 * - `/coworking-react :crown:` sets it (custom workspace emoji too)
 * - `/coworking-react` shows it
 * - `/coworking-react off` clears it (`:off:`, with colons, is an emoji named "off")
 */

export const REACT_COMMAND = "/coworking-react";

/**
 * An emoji name as `reactions.add` takes it, optionally wrapped in colons the way Slack's
 * picker types it: lowercase letters, digits, `_ + ' -`, and an optional skin tone
 * (`wave::skin-tone-3`). Captures the bare name.
 */
const EMOJI_ARG = /^:?([a-z0-9_+'-]{1,100}(?:::skin-tone-[2-6])?):?$/;

/**
 * The slash-command fields this handler reads — a structural subset of the framework's
 * `SlashCommand` payload, kept narrow so tests can construct it directly.
 */
export interface ReactCommandPayload {
  text: string;
  user_id: string;
  response_url: string;
}

type ParsedReactCommand =
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "set"; emoji: string }
  | { kind: "invalid"; input: string };

export function parseReactCommand(text: string): ParsedReactCommand {
  const input = text.trim();
  if (!input) return { kind: "show" };
  if (input.toLowerCase() === "off") return { kind: "clear" };
  const match = EMOJI_ARG.exec(input.toLowerCase());
  return match ? { kind: "set", emoji: match[1]! } : { kind: "invalid", input };
}

export async function handleReactCommand(cmd: ReactCommandPayload, env: Env): Promise<void> {
  const parsed = parseReactCommand(cmd.text);
  if (parsed.kind === "invalid") {
    await respondEphemeral(cmd.response_url, invalidText(parsed.input));
    return;
  }

  try {
    const room = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
    let text: string;
    switch (parsed.kind) {
      case "show":
        text = showText(await room.getJoinReaction(cmd.user_id));
        break;
      case "clear":
        await room.setJoinReaction(cmd.user_id, null);
        text = CLEARED_TEXT;
        break;
      case "set":
        await room.setJoinReaction(cmd.user_id, parsed.emoji);
        text = setText(parsed.emoji, env.ROOM_TITLE);
        break;
    }
    log.info("coworking.react_command", { user: cmd.user_id, op: parsed.kind });
    await respondEphemeral(cmd.response_url, text);
  } catch (err) {
    const reported = reportFailure(env, "coworking.react_command_failed", err, {
      user: cmd.user_id,
    });
    try {
      await respondEphemeral(cmd.response_url, ERROR_TEXT);
    } finally {
      await reported;
    }
  }
}

// --- Copy ---

const USAGE = "Try `/coworking-react :tada:`, or `/coworking-react off` to stop.";

function setText(emoji: string, roomTitle: string): string {
  return [
    `:white_check_mark: Got it! I'll react with :${emoji}: on the ${roomTitle} message whenever you join.`,
    "If someone else picked the same emoji, it shows as one reaction.",
  ].join("\n");
}

function showText(emoji: string | null): string {
  return emoji
    ? `Your co-working reaction is :${emoji}:. ${USAGE}`
    : `You haven't picked a co-working reaction yet. ${USAGE}`;
}

const CLEARED_TEXT = "Done. I won't react when you join the co-working room.";

function invalidText(input: string): string {
  return `\`${input}\` isn't an emoji name. ${USAGE}`;
}

const ERROR_TEXT =
  ":warning: Something went wrong saving your co-working reaction. Please try again in a bit.";
