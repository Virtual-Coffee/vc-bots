/**
 * Zoom "Create a meeting's invite links" API.
 *
 * Generates a per-attendee join link with the attendee's name pre-filled, so a member taps Join and
 * lands straight in the meeting (no registration, no email, no form). The meeting must NOT require
 * registration for these links to drop people in directly.
 *
 * Correlation is best-effort: the `participant_joined` webhook carries no registrant id for an
 * invite-link joiner, only the `user_name` we baked in here — so we match on that name later.
 *
 * @see https://developers.zoom.us/docs/api/meetings/ (Create a meeting's invite links)
 */

import { log } from "../log";

const ZOOM_API_BASE = "https://api.zoom.us/v2";

/** Link lifetime (seconds). Only needs to cover click→join; Zoom enforces `ttl` loosely. */
const DEFAULT_TTL = 7200;

interface InviteLinksResponse {
  attendees?: Array<{ name?: string; join_url?: string }>;
}

/**
 * Mint a personalized invite link for `name`. Returns the attendee's unique `join_url`.
 */
export async function createInviteLink(
  accessToken: string,
  meetingId: string,
  name: string,
  ttl: number = DEFAULT_TTL,
): Promise<{ joinUrl: string }> {
  log.debug("zoom.invite_link.create", { meeting: meetingId, name });
  const res = await fetch(`${ZOOM_API_BASE}/meetings/${meetingId}/invite_links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attendees: [{ name }], ttl }),
  });

  if (!res.ok) {
    throw new Error(`Zoom invite-links failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json<InviteLinksResponse>();
  const joinUrl = body.attendees?.[0]?.join_url;
  if (!joinUrl) {
    throw new Error("Zoom invite-links returned no join_url");
  }
  // Never log the join_url — it carries a join token.
  log.debug("zoom.invite_link.created", { meeting: meetingId, name });
  return { joinUrl: new URL(joinUrl).toString() };
}
