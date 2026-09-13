/**
 * Zoom host key lookup for the event-admin mirror (docs/adr/0001).
 *
 * The host key is a per-Zoom-user setting, so it is resolved from the event's Join Link at
 * send time: meeting id → `GET /meetings/{id}` → `host_id` → `GET /users/{host_id}` →
 * `host_key`. S2S apps can't call `/users/me`, hence the two hops. Requires the
 * `meeting:read:meeting:admin` and `user:read:user:admin` granular scopes on the S2S app.
 *
 * @see https://developers.zoom.us/docs/api/meetings/ (Get a meeting; Get a user)
 */

import type { Env } from "../env";
import { log } from "../log";
import { fetchZoomAccessToken, ZOOM_API_BASE } from "./oauth";

/** Zoom meeting ids are 9–11 digits and sit under `/j/` in every join url variant. */
const MEETING_ID_RE = /zoom\.us\/j\/(\d{9,11})(?:[/?#]|$)/;

/** The Zoom meeting id inside a Join Link, or `null` when the url isn't a Zoom join url. */
export function parseZoomMeetingId(url: string): string | null {
  return MEETING_ID_RE.exec(url)?.[1] ?? null;
}

export type HostKeyResolver = (meetingId: string) => Promise<string>;

/**
 * Build a per-run resolver: one S2S token, one meeting GET per meeting, one user GET per host.
 * Any Zoom failure throws so the reminder run fails loudly rather than posting without the key.
 */
export function createHostKeyResolver(env: Env): HostKeyResolver {
  let token: Promise<string> | undefined;
  const byMeeting = new Map<string, Promise<string>>();
  const byHost = new Map<string, Promise<string>>();

  const accessToken = () => (token ??= fetchZoomAccessToken(env).then((t) => t.access_token));

  const hostKeyForHost = (hostId: string) => {
    let pending = byHost.get(hostId);
    if (!pending) {
      pending = accessToken().then(async (bearer) => {
        const user = await zoomGet<{ host_key?: string }>(bearer, `/users/${hostId}`, "user");
        if (!user.host_key) throw new Error("Zoom user returned no host_key");
        return user.host_key;
      });
      byHost.set(hostId, pending);
    }
    return pending;
  };

  return (meetingId) => {
    let pending = byMeeting.get(meetingId);
    if (!pending) {
      pending = accessToken().then(async (bearer) => {
        const meeting = await zoomGet<{ host_id?: string }>(
          bearer,
          `/meetings/${meetingId}`,
          "meeting",
        );
        if (!meeting.host_id) throw new Error("Zoom meeting returned no host_id");
        const hostKey = await hostKeyForHost(meeting.host_id);
        // Never log the host key or the token.
        log.debug("zoom.host_key.resolved", { meetingId });
        return hostKey;
      });
      byMeeting.set(meetingId, pending);
    }
    return pending;
  };
}

async function zoomGet<T>(accessToken: string, path: string, op: string): Promise<T> {
  const res = await fetch(`${ZOOM_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Zoom get-${op} failed: ${res.status} ${await res.text()}`);
  }
  return res.json<T>();
}
