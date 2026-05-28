/**
 * Zoom "Add a meeting registrant" API.
 *
 * Registering a member up front (at Slack-click time) is what makes later participant
 * correlation reliable: the response's `registrant_id` is the same id Zoom later sends on
 * `participant_joined`, so we can hold `registrant_id ↔ slack_user_id` before anyone joins.
 *
 * The meeting must have registration enabled with `approval_type: 0` (auto-approve) for the
 * returned `join_url` to be immediately usable.
 *
 * @see https://developers.zoom.us/docs/api/meetings/ (Meeting Registrant Create)
 */

import { log } from "../log";

const ZOOM_API_BASE = "https://api.zoom.us/v2";

export interface AddRegistrantInput {
  email: string;
  firstName: string;
  lastName?: string;
}

export interface ZoomRegistrant {
  /** Numeric registrant id (Zoom also echoes it as `registrant_id` on webhooks). */
  registrant_id: string;
  id?: string;
  /** Unique, per-registrant join URL. */
  join_url: string;
}

export async function addMeetingRegistrant(
  accessToken: string,
  meetingId: string,
  input: AddRegistrantInput,
): Promise<ZoomRegistrant> {
  log.debug("zoom.registrant.create", { meeting: meetingId, email: input.email });
  const res = await fetch(`${ZOOM_API_BASE}/meetings/${meetingId}/registrants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      first_name: input.firstName,
      ...(input.lastName ? { last_name: input.lastName } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Zoom add-registrant failed: ${res.status} ${await res.text()}`);
  }
  const registrant = await res.json<ZoomRegistrant>();
  log.debug("zoom.registrant.created", { meeting: meetingId, registrant: registrant.registrant_id });
  return registrant;
}
