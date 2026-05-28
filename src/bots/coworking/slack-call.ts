import type { AnyMessageBlock, SlackAPIClient } from "slack-web-api-client";
import type { Env } from "../../env";

/**
 * Thin wrappers over the Slack Calls API.
 *
 * `slack-web-api-client` doesn't expose a typed `calls.*` group, but its generic
 * `client.call("calls.add", …)` reaches every Web API method (and auto-JSON-encodes object/
 * array params). So we call through that with small local types — staying within the
 * "only slack-web-api-client" constraint (no `@slack/web-api`).
 */

/** A Slack Call participant: a known member (`slack_id`) or an external guest. */
export type CallUser = { slack_id: string } | { external_id: string; display_name: string };

/**
 * Decide how a Zoom participant maps to a Slack Call user: a correlated registrant becomes a
 * known member (`slack_id`); everyone else is shown as an external guest (`external_id`).
 */
export function toCallUser(
  registrant: { slack_user_id?: string | null } | undefined,
  participant: { zoomUserId: string; displayName: string },
): CallUser {
  if (registrant?.slack_user_id) return { slack_id: registrant.slack_user_id };
  return { external_id: participant.zoomUserId, display_name: participant.displayName };
}

interface CallsAddInput {
  externalUniqueId: string;
  joinUrl: string;
  title: string;
  createdBy: string;
  dateStartSec: number;
}

/** Create a Slack Call; returns its id (`R…`). */
export async function callsAdd(client: SlackAPIClient, input: CallsAddInput): Promise<string> {
  const res = (await client.call("calls.add", {
    external_unique_id: input.externalUniqueId,
    join_url: input.joinUrl,
    title: input.title,
    created_by: input.createdBy,
    date_start: input.dateStartSec,
  })) as { ok: boolean; error?: string; call?: { id?: string } };
  if (!res.ok || !res.call?.id) {
    throw new Error(`calls.add failed: ${res.error ?? "no call id"}`);
  }
  return res.call.id;
}

/** End a Slack Call. `inactive_call` (already ended) is treated as success (idempotent). */
export async function callsEnd(client: SlackAPIClient, callId: string): Promise<void> {
  const res = await client.call("calls.end", { id: callId });
  if (!res.ok && res.error !== "inactive_call") {
    throw new Error(`calls.end failed: ${res.error}`);
  }
}

export async function callsParticipantsAdd(
  client: SlackAPIClient,
  callId: string,
  users: CallUser[],
): Promise<void> {
  const res = await client.call("calls.participants.add", { id: callId, users });
  if (!res.ok) throw new Error(`calls.participants.add failed: ${res.error}`);
}

export async function callsParticipantsRemove(
  client: SlackAPIClient,
  callId: string,
  users: CallUser[],
): Promise<void> {
  const res = await client.call("calls.participants.remove", { id: callId, users });
  // Removing someone already gone is fine.
  if (!res.ok && res.error !== "user_not_found") {
    throw new Error(`calls.participants.remove failed: ${res.error}`);
  }
}

/**
 * Channel message blocks for an open room: intro + interactive Join button (per-user
 * registrant links) + the live Call widget (when a call was created).
 */
export function buildRoomOpenBlocks(env: Env, callId?: string): AnyMessageBlock[] {
  const blocks: AnyMessageBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:coffee: The *${env.ROOM_TITLE}* is now open!` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: JOIN_ACTION_ID,
          text: { type: "plain_text", text: "Join the co-working room", emoji: true },
          style: "primary",
        },
      ],
    },
  ];
  // The `call` block isn't in slack-web-api-client's typed block union; it's valid Slack.
  if (callId) {
    blocks.push({ type: "call", call_id: callId } as unknown as AnyMessageBlock);
  }
  return blocks;
}

/** action_id of the interactive Join button. */
export const JOIN_ACTION_ID = "coworking_join";
