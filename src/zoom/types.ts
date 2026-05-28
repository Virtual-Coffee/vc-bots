/**
 * Zoom meeting webhook payloads (the subset the co-working room consumes).
 * @see https://developers.zoom.us/docs/api/meetings/events/
 */

export interface ZoomParticipant {
  /** Ephemeral per-meeting user id — used for join/leave matching, NOT identity. */
  user_id?: string;
  /** Stable-ish participant id (present when logged in). */
  participant_user_id?: string;
  /** Ephemeral per-meeting uuid. */
  participant_uuid?: string;
  /** Correlation key set when the person joined via a registrant link (Phase 5). */
  registrant_id?: string;
  user_name?: string;
  email?: string;
  join_time?: string;
  leave_time?: string;
}

export interface ZoomMeetingObject {
  /** Meeting id (Zoom sends this as a number). */
  id: string | number;
  /** Meeting instance uuid (unique per occurrence). */
  uuid: string;
  host_id?: string;
  topic?: string;
  type?: number;
  start_time?: string;
  end_time?: string;
  duration?: number;
  timezone?: string;
  /** Present on participant_joined / participant_left. */
  participant?: ZoomParticipant;
}

export type ZoomMeetingEventType =
  | "meeting.started"
  | "meeting.ended"
  | "meeting.participant_joined"
  | "meeting.participant_left";

export interface ZoomMeetingEvent {
  event: ZoomMeetingEventType;
  event_ts?: number;
  payload: {
    account_id?: string;
    object: ZoomMeetingObject;
  };
}

/** Loose envelope used at the HTTP boundary before narrowing (covers url_validation too). */
export interface ZoomInboundEvent {
  event: string;
  event_ts?: number;
  payload?: {
    plainToken?: string;
    object?: ZoomMeetingObject;
  };
}

const MEETING_EVENT_TYPES = new Set<string>([
  "meeting.started",
  "meeting.ended",
  "meeting.participant_joined",
  "meeting.participant_left",
]);

export function isZoomMeetingEvent(body: ZoomInboundEvent): body is ZoomMeetingEvent {
  return MEETING_EVENT_TYPES.has(body.event) && !!body.payload?.object;
}
