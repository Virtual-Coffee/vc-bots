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

// --- Parity message copy ---

export function roomOpenText(env: Env): string {
  return `:coffee: The *${env.ROOM_TITLE}* is now open! Tap Join to hop in.`;
}

export function roomClosedText(env: Env): string {
  return `:zzz: The *${env.ROOM_TITLE}* session has ended. Start a new one any time!`;
}

/** Human-friendly session length: `"1h 23m"`, `"45m"`, or `"<1m"` for anything under a minute. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
