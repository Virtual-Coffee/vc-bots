# 0006 — `#bot-log` alerts are explicit calls at surface-less catch sites, not a logger hook

**Status:** Accepted (2026-09-17)

## Context

Most failures here surface on their own: a slash command or button reply reaches the user
through `response_url`, and the App Home / welcome paths fail visibly in Slack. Three paths
have no user in front of them — the cron reminder run, the Zoom webhook → co-working DO
handlers, and the join flow after the ephemeral has been posted. A failure there is a silent
log line at whatever `LOG_LEVEL` production runs at.

The obvious fix is to have `log.error` post to Slack. That would page on every error, including
the ones that already reached a user, and — since the alert itself is a Slack call — a Slack
outage would make every failed alert log an error that posts another alert.

## Decision

- **`notifyBotLog(env, event, fields)`** (`src/slack/notify.ts`) posts one message to the
  private `#bot-log` channel (`SLACK_BOTLOG_CHANNEL_ID`).
- **It is called explicitly**, at the few catch sites with no other surface: `reminder.run_failed`
  (the cron run), `zoom.webhook.failed` (the router's DO dispatch), `join.failed` (the join
  flow). Adding an alert is a deliberate call at a new catch site, not a side effect of
  logging.
- **Three guarantees**, because it runs on the failure path:
  - **No-op when unconfigured** — empty channel id returns immediately (tests, dev, before the
    bot is invited to the channel).
  - **Self-swallowing** — a throw or non-2xx from the post is `log.warn`ed
    (`botlog.notify_failed`) and never rethrown, so the alert cannot fail the caller.
  - **No recursion** — a failed alert is never itself alerted.
- **Hooking the logger is rejected**: every `log.error` would page, and the outage case
  recurses.

## Consequences

- `#bot-log` is low-volume by construction: an alert means a path with no other surface
  broke.
- A new fire-and-forget path (a future cron, a new webhook) must add its own `notifyBotLog`
  call in its catch, or its failures stay invisible.
- Alert text mirrors the console logger's `key=val` shape; the same rule applies — personal
  `join_url`s and join tokens never go in the fields.
