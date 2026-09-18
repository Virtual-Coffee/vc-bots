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

import type { Env } from "../env";
import type { paths } from "../generated/zoom-meetings";
import { apiError, createApiClient } from "../http/client";
import { log } from "../log";
import { ZOOM_API_BASE, type TokenCacheStorage, getCachedZoomToken } from "./oauth";

/** Link lifetime (seconds). Only needs to cover click→join; Zoom enforces `ttl` loosely. */
const DEFAULT_TTL = 7200;

const meetings = createApiClient<paths>({ baseUrl: ZOOM_API_BASE });

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
  const { data, error, response } = await meetings.POST("/meetings/{meetingId}/invite_links", {
    // The spec types the id as an integer; ours is the string from `ZOOM_MEETING_ID`.
    params: { path: { meetingId: Number(meetingId) } },
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { attendees: [{ name }], ttl },
  });

  if (!response.ok) {
    throw apiError("zoom", "Zoom invite-links failed", { response, error });
  }
  const joinUrl = data?.attendees?.[0]?.join_url;
  if (!joinUrl) {
    throw new Error("Zoom invite-links returned no join_url");
  }
  // Never log the join_url — it carries a join token.
  log.debug("zoom.invite_link.created", { meeting: meetingId, name });
  return { joinUrl: new URL(joinUrl).toString() };
}

// --- Port ---

/**
 * What the co-working room needs from Zoom: a personal join link for a display name. The DO
 * takes this as a swappable field so tests can hand it a fake instead of stubbing `fetch`.
 */
export interface InviteLinkPort {
  mint(displayName: string): Promise<{ joinUrl: string }>;
}

/** The real port: S2S token (cached in `storage`) + `createInviteLink` for `ZOOM_MEETING_ID`. */
export function createZoomInviteLinkPort(env: Env, storage: TokenCacheStorage): InviteLinkPort {
  return {
    async mint(displayName) {
      const accessToken = await getCachedZoomToken(env, storage);
      return createInviteLink(accessToken, env.ZOOM_MEETING_ID, displayName);
    },
  };
}
