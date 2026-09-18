import { DateTime } from "luxon";
import type { AnyMessageBlock } from "slack-cloudflare-workers";

/**
 * The availability check-in messages — pure Block Kit builders and the reaction → sign-up sheet
 * projection. No I/O: the `AvailabilitySheet` Durable Object decides *when* to post and refresh;
 * this module decides what the channel should look like.
 *
 * Vocabulary (CONTEXT.md): the Monday trio is the *intro message* plus two *day messages*; each
 * day message carries a *sign-up sheet* — one list of *sign-ups* per *role*, projected from the
 * message's own reactions.
 */

export type Role = "host" | "mc" | "notetaker" | "roomLeader" | "unavailable";

export interface RoleSpec {
  role: Role;
  label: string;
  /** The reaction name (`:computer:` → `computer`) that signs someone up for this role. */
  reaction: string;
}

/** Seed + render order. Unavailable is a role too, so people can say so with one click. */
export const ROLES: readonly RoleSpec[] = [
  { role: "host", label: "Host", reaction: "computer" },
  { role: "mc", label: "MC", reaction: "microphone" },
  { role: "notetaker", label: "Notetaker", reaction: "memo" },
  { role: "roomLeader", label: "Room leader", reaction: "speech_balloon" },
  { role: "unavailable", label: "Unavailable", reaction: "x" },
];

export type Day = "tuesday" | "thursday";
export const DAYS: readonly Day[] = ["tuesday", "thursday"];

/** Slack user IDs signed up for each role, in the order they reacted. */
export type SignUpSheet = Record<Role, string[]>;

export const EASTERN = "America/New_York";

/** The subset of a `reactions.get` reaction this module reads. */
export interface ReactionUsers {
  name?: string;
  users?: string[];
}

export function emptySheet(): SignUpSheet {
  return { host: [], mc: [], notetaker: [], roomLeader: [], unavailable: [] };
}

/**
 * Project a message's reactions onto the sign-up sheet. Unknown reactions are ignored, the bot's
 * own seed reactions never count, and Slack's per-reaction user order is kept.
 */
export function sheetFromReactions(
  reactions: readonly ReactionUsers[] | undefined,
  botUserId: string | undefined,
): SignUpSheet {
  const sheet = emptySheet();
  for (const { role, reaction } of ROLES) {
    const users = reactions?.find((r) => r.name === reaction)?.users ?? [];
    sheet[role] = users.filter((u) => u !== botUserId);
  }
  return sheet;
}

/** The Tuesday and Thursday of the current Mon–Sun week in Eastern time, even when already past. */
export function weekDays(nowMs: number): Record<Day, DateTime> {
  const monday = DateTime.fromMillis(nowMs, { zone: EASTERN }).startOf("week");
  return { tuesday: monday.plus({ days: 1 }), thursday: monday.plus({ days: 3 }) };
}

export interface BuiltMessage {
  text: string;
  blocks: AnyMessageBlock[];
}

const INTRO_TEXT =
  "<!channel> Hey friends, who's available this week and is up for leading or taking notes? Both days posted below. Feel free to choose one or multiple options for each day:";

const INTRO_HINT =
  "React on each day's message with the emoji for the roles you can take — the lists update automatically.";

const DAY_HINT =
  "React with the emoji for each role you can take — remove your reaction to withdraw.";

export function buildIntroMessage(): BuiltMessage {
  const legend = ROLES.map((r) => `• ${r.label}: :${r.reaction}: (\`:${r.reaction}:\`)`).join("\n");
  return {
    text: INTRO_TEXT,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: INTRO_TEXT } },
      { type: "section", text: { type: "mrkdwn", text: legend } },
      { type: "context", elements: [{ type: "mrkdwn", text: INTRO_HINT }] },
    ],
  };
}

const DAY_LABEL: Record<Day, string> = { tuesday: "Tuesday", thursday: "Thursday" };

export function buildDayMessage(day: Day, date: DateTime, sheet: SignUpSheet): BuiltMessage {
  const title = `${DAY_LABEL[day]} · ${date.setZone(EASTERN).toFormat("LLL d")}`;
  const lines = ROLES.map(({ role, label, reaction }) => {
    const people = sheet[role].map((u) => `<@${u}>`).join(", ");
    return `:${reaction}: *${label}:* ${people || "—"}`;
  }).join("\n");
  return {
    text: `${title} — who's available`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: lines } },
      { type: "context", elements: [{ type: "mrkdwn", text: DAY_HINT }] },
    ],
  };
}
