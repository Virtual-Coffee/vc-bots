/** Zoom meeting ids are 9–11 digits and sit under `/j/` in every join url variant. */
const MEETING_ID_RE = /zoom\.us\/j\/(\d{9,11})(?:[/?#]|$)/;

/** The Zoom meeting id inside a Join Link, or `null` when the url isn't a Zoom join url. */
export function parseZoomMeetingId(url: string): string | null {
  return MEETING_ID_RE.exec(url)?.[1] ?? null;
}
