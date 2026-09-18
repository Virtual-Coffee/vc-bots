import { DateTime } from "luxon";
import type { AnyMessageBlock } from "slack-cloudflare-workers";

/**
 * The availability check-in messages — pure Block Kit builders and the reaction → sign-up sheet
 * projection. No I/O: the `AvailabilitySheet` Durable Object decides *when* to post and refresh;
 * this module decides what the channel should look like.
 *
 * Vocabulary (CONTEXT.md): the Monday trio is the *intro message* plus two *day messages*; each
 * day message carries a *sign-up sheet* — one list of *sign-ups* per *role*, plus who is *out*,
 * all projected from the message's own reactions.
 */

export type Role = "host" | "mc" | "notetaker" | "roomLeader";

export interface RoleSpec {
  role: Role;
  label: string;
  /** The reaction name (`:computer:` → `computer`) that signs someone up for this role. */
  reaction: string;
}

/** Legend, seed and render order. */
export const ROLES: readonly RoleSpec[] = [
  { role: "host", label: "Host", reaction: "computer" },
  { role: "mc", label: "MC", reaction: "microphone" },
  { role: "notetaker", label: "Notetaker", reaction: "memo" },
  { role: "roomLeader", label: "Room leader", reaction: "speech_balloon" },
];

/** `:x:` — the person is out that day, whatever else they reacted with. */
export const OUT_REACTION = "x";

/**
 * Easter egg: `:all-the-things:` signs the reactor up for every role. Never seeded, never in the
 * legend — people find it or they don't.
 */
export const ALL_THE_THINGS_REACTION = "all-the-things";

/** What the bot adds to each day message right after posting: the four role emoji and `:x:`. */
export const SEED_REACTIONS: readonly string[] = [...ROLES.map((r) => r.reaction), OUT_REACTION];

export type Day = "tuesday" | "thursday";
export const DAYS: readonly Day[] = ["tuesday", "thursday"];

/** Slack user IDs per role, in the order they reacted, plus who is out that day. */
export interface SignUpSheet {
  roles: Record<Role, string[]>;
  out: string[];
}

export const EASTERN = "America/New_York";

/** The subset of a `reactions.get` reaction this module reads. */
export interface ReactionUsers {
  name?: string;
  users?: string[];
}

export function emptySheet(): SignUpSheet {
  return { roles: { host: [], mc: [], notetaker: [], roomLeader: [] }, out: [] };
}

/**
 * Project a message's reactions onto the sign-up sheet (ADR 0013, "Projection rules"):
 *
 * 1. `:x:` wins — anyone out is dropped from every role, even if their role reactions remain.
 * 2. `:all-the-things:` puts the reactor on every role, after the direct reactors, once.
 * 3. Unknown reactions are ignored, the bot's own seed reactions never count, and Slack's
 *    per-reaction user order is kept.
 */
export function sheetFromReactions(
  reactions: readonly ReactionUsers[] | undefined,
  botUserId: string | undefined,
): SignUpSheet {
  const usersOf = (name: string): string[] =>
    (reactions?.find((r) => r.name === name)?.users ?? []).filter((u) => u !== botUserId);

  const sheet = emptySheet();
  sheet.out = usersOf(OUT_REACTION);
  const everything = usersOf(ALL_THE_THINGS_REACTION);
  for (const { role, reaction } of ROLES) {
    const direct = usersOf(reaction);
    const merged = [...direct, ...everything.filter((u) => !direct.includes(u))];
    sheet.roles[role] = merged.filter((u) => !sheet.out.includes(u));
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

const INTRO_TITLE = ":spiral_calendar_pad: Who can help out this week?";

const INTRO_TEXT =
  "<!channel> Hey friends, who's available this week and is up for leading or taking notes? Both days posted below. Feel free to choose one or multiple options for each day:";

const INTRO_HINT =
  ":point_down: Sign up by reacting on a day message — the lists there update themselves.";

const DAY_HINT = `Tap a reaction to sign up · remove it to withdraw · :${OUT_REACTION}: if you're out`;

export function buildIntroMessage(): BuiltMessage {
  const legend = [
    ...ROLES.map((r) => `:${r.reaction}: *${r.label}*`),
    `:${OUT_REACTION}: *Unavailable*`,
  ];
  return {
    text: INTRO_TEXT,
    blocks: [
      { type: "header", text: { type: "plain_text", text: INTRO_TITLE, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: INTRO_TEXT } },
      { type: "section", fields: legend.map((text) => ({ type: "mrkdwn", text })) },
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: INTRO_HINT }] },
    ],
  };
}

const DAY_LABEL: Record<Day, string> = { tuesday: "Tuesday", thursday: "Thursday" };

const mentions = (users: readonly string[]): string => users.map((u) => `<@${u}>`).join(", ");

export function buildDayMessage(day: Day, date: DateTime, sheet: SignUpSheet): BuiltMessage {
  const title = `${DAY_LABEL[day]} · ${date.setZone(EASTERN).toFormat("LLL d")}`;
  const lines = ROLES.map(
    ({ role, label, reaction }) =>
      `:${reaction}: *${label}:* ${mentions(sheet.roles[role]) || "—"}`,
  ).join("\n");
  const out = `:${OUT_REACTION}: Out ${DAY_LABEL[day]}: ${mentions(sheet.out) || "nobody yet"}`;
  return {
    text: `${title} — who's available`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: lines } },
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: out }] },
      { type: "context", elements: [{ type: "mrkdwn", text: DAY_HINT }] },
    ],
  };
}
