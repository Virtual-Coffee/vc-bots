import type { ReactionAddedEvent, ReactionRemovedEvent } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log } from "../../log";
import { notifyBotLog } from "../../slack/notify";

/**
 * Worker-side glue for the availability check-in: the cron / admin entry point that posts the
 * Monday trio, and the `reaction_added` / `reaction_removed` handler that asks the
 * `AvailabilitySheet` Durable Object to re-render a day message. Everything is a no-op while
 * `SLACK_AVAILABILITY_CHANNEL_ID` is empty (feature off).
 */

function sheetStub(env: Env) {
  return env.AVAILABILITY_SHEET.getByName(env.SLACK_AVAILABILITY_CHANNEL_ID);
}

/** Post this week's check-in trio. Resolves to null when the feature is off. */
export async function postAvailabilityCheckIn(
  env: Env,
  nowMs: number = Date.now(),
): Promise<{ tuesday: string; thursday: string } | null> {
  if (!env.SLACK_AVAILABILITY_CHANNEL_ID) {
    log.info("availability.disabled");
    return null;
  }
  return sheetStub(env).post(nowMs);
}

/**
 * The reaction-event fields the handler reads — a structural subset of slack-edge's
 * `ReactionAddedEvent` / `ReactionRemovedEvent`. slack-edge types `item` as message-only, but
 * file reactions arrive at runtime with `item.type: "file"`, so the guard stays.
 */
export interface ReactionChangePayload {
  user: string;
  item: { type: string; channel?: string; ts?: string };
}

// Both event types satisfy the payload shape; keep the compiler checking that they still do.
const _typeCheck: [ReactionChangePayload, ReactionChangePayload] = [
  {} as ReactionAddedEvent,
  {} as ReactionRemovedEvent,
];
void _typeCheck;

/** Refresh the day message a reaction landed on. Reactions anywhere else are dropped up front. */
export async function handleReactionChange(
  payload: ReactionChangePayload,
  env: Env,
): Promise<void> {
  const channel = env.SLACK_AVAILABILITY_CHANNEL_ID;
  if (!channel) return;
  const { item } = payload;
  if (item.type !== "message" || item.channel !== channel || !item.ts) return;
  try {
    const result = await sheetStub(env).refresh(item.ts, payload.user);
    log.debug("availability.refresh", { ts: item.ts, result });
  } catch (error) {
    log.error("availability.refresh_failed", { ts: item.ts, error: String(error) });
    await notifyBotLog(env, "availability.refresh_failed", { ts: item.ts, error: String(error) });
  }
}
