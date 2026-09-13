# 0001 — Event model: Join Link is `location`, host key comes from Zoom

**Status:** Accepted (2026-09-13)

## Context

virtualcoffee.io ADR 0014 (`docs/adr/0014-google-calendar-is-the-events-system-of-record.md`
in that repo) made Google Calendar the system of record for events: the Join Link is the event's `location`,
nothing lives in `extendedProperties`, and the Zoom host code is not an Event field — the
calendar is public, and `private` extended properties are per-calendar-copy rather than per-app,
so storing the host code there exposed it to any API reader.

The bots' Google source (`feat/gcal`) had grown its own convention on top of
`extendedProperties` (`joinLink`, `hostCode`, `slackChannelId`, plus legacy `shared` keys) and
still carried the CMS GraphQL source it was meant to replace.

## Decision

- **Join Link = `location`.** The adapter reads `location` first and falls back to a video
  `conferenceData` entry point; `extendedProperties` is never read.
- **Host key is resolved from Zoom at send time.** The host key is a per-Zoom-user setting, so
  `reconcileStartingSoon` parses the meeting id out of the Join Link and asks Zoom
  (`GET /meetings/{id}` → `host_id` → `GET /users/{host_id}` → `host_key`; S2S apps cannot use
  `/users/me`). Only events that will actually be announced cost Zoom calls; results are cached
  per run. A Zoom failure fails the run (it reaches `#bot-log` via `reminder.run_failed`) — there
  is no "post without the host key" mode. A non-Zoom Join Link simply has no host-code line.
- **The host key appears only in the event-admin mirror** and is never logged.
- **Descriptions are Markdown**, rendered with `slackify-markdown` (pure ESM on unified/remark,
  runs on workerd). The local `html-to-mrkdwn` converter is gone; there is no HTML tolerance.
- **The CMS source is removed** with the cutover. The `EventSource` registry stays as the
  `EVENT_SOURCE` / admin `[source]` seam, with `google` as its only entry.

## Consequences

- `ReminderEvent` loses `zoomHostCode` and `slackChannelId`.
- The Zoom S2S app needs the `meeting:read:admin` and `user:read:admin` scopes.
- `CMS_TOKEN`, `CMS_GRAPHQL_URL`, `graphql`, and `graphql-request` are gone.
- Calendar migration (manual): set `location` on the Morning/Afternoon Crowd series, clear the
  old `joinLink`/`hostCode` properties, and convert existing descriptions to Markdown.
