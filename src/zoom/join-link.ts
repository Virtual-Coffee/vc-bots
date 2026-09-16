/** Zoom meeting ids are 9–11 digits and sit under `/j/` in every join url variant. */
const MEETING_PATH_RE = /^\/j\/(\d{9,11})\/?$/;

/** Only zoom.us itself and its subdomains (us02web, vanity) — not lookalikes like notzoom.us. */
function isZoomHost(hostname: string): boolean {
  return hostname === "zoom.us" || hostname.endsWith(".zoom.us");
}

/**
 * Parses `value` as a url, but only an http(s) one — any other scheme (or an unparsable string,
 * e.g. a free-text location) is treated as not a url at all. `new URL` lower-cases the scheme,
 * so `HTTPS://…` parses fine.
 */
export function parseHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null; // free-text location, not a url
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

/** The Zoom meeting id inside a Join Link, or `null` when the url isn't a Zoom join url. */
export function parseZoomMeetingId(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null) return null;
  if (!isZoomHost(parsed.hostname)) return null;
  return MEETING_PATH_RE.exec(parsed.pathname)?.[1] ?? null;
}
