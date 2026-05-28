import type { Env } from "../../env";
import type { ZoomMeetingEvent, ZoomParticipant } from "../../zoom/types";

/**
 * Pure helpers for interpreting Zoom meeting events and building the parity (plain-message)
 * co-working notifications. The Durable Object (durable-object.ts) owns the state machine and
 * Slack I/O; these are the side-effect-free bits, kept here so they're easy to unit-test.
 */

export interface ParticipantIdentity {
  /** Per-meeting id used to match a later participant_left to this join. */
  zoomUserId: string;
  displayName: string;
  registrantId?: string;
  email?: string;
}

export function meetingId(event: ZoomMeetingEvent): string {
  return String(event.payload.object.id);
}

export function instanceUuid(event: ZoomMeetingEvent): string {
  return event.payload.object.uuid;
}

/** Event timestamp in ms — prefer Zoom's `event_ts`, fall back to wall clock. */
export function eventTimeMs(event: ZoomMeetingEvent): number {
  return typeof event.event_ts === "number" ? event.event_ts : Date.now();
}

export function participantIdentity(p: ZoomParticipant): ParticipantIdentity {
  // user_id is the per-meeting handle Zoom reuses across this participant's join/leave pair.
  // participant_uuid is the most reliable fallback if user_id is absent.
  const zoomUserId = p.user_id || p.participant_uuid || p.participant_user_id || p.registrant_id || "";
  return {
    zoomUserId,
    displayName: p.user_name?.trim() || "A guest",
    registrantId: p.registrant_id || undefined,
    email: p.email || undefined,
  };
}

// --- Parity message copy ---

export function roomOpenText(env: Env): string {
  return `:coffee: The *${env.ROOM_TITLE}* is now open! Join here: ${env.ZOOM_MEETING_INVITE_URL}`;
}

export function roomClosedText(env: Env): string {
  return `:zzz: The *${env.ROOM_TITLE}* session has ended. Start a new one any time!`;
}
