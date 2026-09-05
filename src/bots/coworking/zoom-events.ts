import type { ZoomMeetingEvent, ZoomParticipant } from "../../zoom/types";

/**
 * Pure helpers for interpreting Zoom meeting events. The Durable Object (durable-object.ts) owns
 * the session state machine and `RoomMessage` (room-message.ts) the channel message; these are
 * the side-effect-free bits, kept here so they're easy to unit-test.
 */

export interface ParticipantIdentity {
  /** Per-meeting id used to match a later participant_left to this join. */
  zoomUserId: string;
  displayName: string;
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
  const zoomUserId = p.user_id || p.participant_uuid || p.participant_user_id || "";
  return {
    zoomUserId,
    displayName: p.user_name?.trim() || "A guest",
  };
}
