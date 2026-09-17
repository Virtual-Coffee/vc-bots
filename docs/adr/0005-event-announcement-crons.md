# 0005 — Event announcements: two UTC crons keyed by their literal string, starting-soon via `chat.scheduleMessage`

**Status:** Accepted (2026-09-17)

## Context

Event announcements are three kinds of message: a daily summary, a weekly summary, and a
per-event "Starting Soon" pair (public + event-admin mirror) at start − 10 min. Cloudflare
cron triggers are the only clock the Worker has. They fire in UTC, and `scheduled()` receives
the fired expression as `controller.cron` — the configured string, character for character.

Two things went wrong on the way here. Weekdays: Cloudflare parses the day-of-week field
Quartz-style (`1` = Sunday … `7` = Saturday), not Unix-style (`0` = Sunday), so the weekly cron
written as `0 12 * * 1` fired on Sunday (fixed in `0b63679`). Disabling: removing the
`triggers` key from `wrangler.jsonc` does not deregister crons already deployed — they keep
firing against the new code.

## Decision

- **Two crons, both at 12:00 UTC**: `0 12 * * *` (daily) and `0 12 * * MON` (weekly). 12:00
  UTC is 8am EDT / 7am EST; the DST drift is accepted rather than adding a timezone layer.
- **`CRON_TO_KIND` (`src/bots/reminders/index.ts`) is keyed on the literal cron string**,
  because that is what `controller.cron` carries. A key that differs from `triggers.crons` by
  one byte means that reminder silently never runs, so `test/reminders-cron.test.ts` asserts
  the two sets are equal.
- **Weekdays are spelled (`MON`, `SUN`), never numeric.** The same test rejects a numeric
  day-of-week field. Luxon's `weekday === 1` in `sendDaily` is ISO Monday and unrelated —
  leave it.
- **Disable by deploying `triggers.crons: []`**, never by deleting the key.
- **Starting-soon messages are Slack-scheduled, not cron-scheduled.** The daily run computes
  each event's start − 10 min and calls `chat.scheduleMessage` for the pair, after deleting
  the bot's scheduled messages in the window so a re-run (manual `/vc-bot-admin daily`)
  reconciles instead of duplicating. Finer-grained crons were rejected: they would poll all day
  to find the same events, and a missed tick would drop an announcement.
- **Mondays the daily skips its summary** — the weekly covers the same events — but still
  schedules the starting-soon pairs.

## Consequences

- Both crons are live. Turning them off is a deploy of `[]`, and turning them back on is a
  deploy of the two strings above.
- Changing a cron means changing it in `wrangler.jsonc` and `CRON_TO_KIND` together; the test
  fails otherwise.
- The starting-soon pairs exist only as Slack scheduled messages. If Slack drops them there is
  no retry until the next daily run; an event added after 12:00 UTC is announced only by a
  manual `/vc-bot-admin daily`.
- The cron run has no user surface, so a failing run alerts `#bot-log` (ADR 0006).
- Three channels, fixed by kind: summaries → `SLACK_ANNOUNCEMENTS_CHANNEL_ID`; the public
  starting-soon message → `SLACK_EVENTS_CHANNEL_ID`; its event-admin mirror (with the Zoom
  host key) → `SLACK_EVENTADMIN_CHANNEL_ID`. Event windows are computed in `America/New_York`
  (`reminderRange`, ADR 0011).
