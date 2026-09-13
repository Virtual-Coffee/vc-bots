import type { DateTime } from "luxon";

/**
 * The date/time tokens Slack substitutes inside a `<!date^…>` string, rendered in each viewer's
 * own timezone. Examples are for `2014-02-18 18:39:42`:
 *
 * - `{date_num}` → `2014-02-18` (zero-padded; developer-friendly)
 * - `{date}` → `February 18th, 2014` (year omitted within ±6 months)
 * - `{date_short}` → `Feb 18, 2014` (year omitted within ±6 months)
 * - `{date_long}` → `Tuesday, February 18th, 2014` (year omitted within ±6 months)
 * - `{date_pretty}` / `{date_short_pretty}` / `{date_long_pretty}` → as above, but
 *   "yesterday"/"today"/"tomorrow" where appropriate
 * - `{time}` → `6:39 PM`, or `18:39` for viewers on a 24-hour clock
 * - `{time_secs}` → `6:39:42 PM`, or `18:39:42` on a 24-hour clock
 * - `{ago}` → a human-readable period, e.g. `2 days ago`
 */
export type SlackDateToken =
  | "{date_num}"
  | "{date}"
  | "{date_short}"
  | "{date_long}"
  | "{date_pretty}"
  | "{date_short_pretty}"
  | "{date_long_pretty}"
  | "{time}"
  | "{time_secs}"
  | "{ago}";

/**
 * A Slack date format: plain text interleaved with `SlackDateToken`s, e.g. `{time}`,
 * `{date_long_pretty} {time}`, or `started {ago}`.
 *
 * Requiring at least one known token catches the failure that actually bites — a mistyped or
 * invented token (`{tim}`, `{date_pretty_long}`) renders as literal braces in the message with no
 * runtime error. It can't reject a bogus token sitting *alongside* a valid one, since TypeScript
 * has no way to assert the whole string is token-or-plain-text.
 */
export type SlackDateFormat = `${string}${SlackDateToken}${string}`;

/**
 * Slack's `<!date^…>` token: the client renders `format` in each viewer's own timezone, falling
 * back to the pre-rendered `fallbackFormat` string wherever it can't (search results, notification
 * previews, older clients).
 *
 * The timestamp is floored — Slack requires an integer epoch-seconds value and silently drops the
 * token otherwise. The fallback is rendered in whatever zone the caller's `dt` carries, so pass a
 * DateTime already anchored to the zone the fallback should read in.
 *
 * @param format Slack date format, e.g. `{time}` or `{date_long_pretty} {time}`.
 * @param fallbackFormat Luxon format for the plain-text fallback, e.g. `t ZZZZ`.
 */
export function dateToken(
  dt: DateTime,
  format: SlackDateFormat,
  fallbackFormat: string,
): string {
  return `<!date^${Math.floor(dt.toSeconds())}^${format}|${dt.toFormat(fallbackFormat)}>`;
}
