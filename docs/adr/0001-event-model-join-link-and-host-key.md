# 0001 — Event model: Join Link is `location`, host key is a private calendar property

**Status:** Accepted (2026-09-13); CMS removal deferred (2026-09-18, see Consequences)

## Context

virtualcoffee.io ADR 0014 (`docs/adr/0014-google-calendar-is-the-events-system-of-record.md`
in that repo) made Google Calendar the system of record for events. As it first read: the Join
Link is the event's `location`, nothing lives in `extendedProperties`, and the Zoom host code is
not an Event field — the calendar was public, and `private` extended properties are
per-calendar-copy rather than per-app, so storing the host code there exposed it to any API
reader.

The bots' Google source (`feat/gcal`) had grown its own convention on top of
`extendedProperties` (`joinLink`, `hostCode`, `slackChannelId`, plus legacy `shared` keys) and
still carried the CMS GraphQL source it was meant to replace.

The first cut of this ADR followed 0014 all the way and had the bot ask Zoom for the host key at
send time (meeting id from the Join Link → `GET /meetings/{id}` → `host_id` →
`GET /users/{host_id}` → `host_key`). That chain is dead on arrival: Zoom **removed `host_key`
from every API response in 2022** "for security reasons", and a live probe with
`user:read:list_users:admin` + `include_fields=host_key` returns no key for any user. Zoom's own
answer is "keep your own datastore" — see
<https://devforum.zoom.us/t/get-a-users-host-key-via-api/79004>.

## Decision

- **Join Link = `location`.** The adapter reads `location` first and falls back to a video
  `conferenceData` entry point; a `private.joinLink` property is ignored.
- **The events calendar is private.** Its ACL is five human owners, the service account (owner),
  and `domain:virtualcoffee.io` as reader — no `default`/public entry (the public ICS feed 404s).
  The website reads through the same service account, so it is unaffected. Workspace-domain
  readers can see private properties; accepted.
- **Host key = `extendedProperties.private.hostCode`** on the (recurring) event. The Google
  source maps it to `ReminderEvent.hostKey` (trimmed; empty → null). It is edited through the
  Calendar API (the website admin page, once it lands), not the Google UI.
- **A Zoom event without a host key fails the run.** `reconcileStartingSoon` throws when the
  Join Link parses as a Zoom meeting (`src/zoom/join-link.ts`) and `hostKey` is empty; the error
  names the event and reaches `#bot-log` via `reminder.run_failed`. There is no "post without the
  host key" mode. A non-Zoom Join Link simply has no host-code line.
  Amended by [0002](0002-join-info-union-and-invalid-events.md): the host-key rule is enforced
  at derivation, not in `reconcileStartingSoon`.
- **The host key appears only in the event-admin mirror** and is never logged.
- **Descriptions are Markdown**, rendered with `slackify-markdown` (pure ESM on unified/remark,
  runs on workerd). The local `html-to-mrkdwn` converter is gone; the Google source has no HTML
  tolerance. _(The interim CMS source converts Craft's HTML at the edge — 2026-09-18 note below.)_
- **The CMS source is removed** with the cutover. The `EventSource` registry stays as the
  `EVENT_SOURCE` / admin `[source]` seam, with `google` as its only entry. _(Deferred — see the
  2026-09-18 note below.)_

## Consequences

- `ReminderEvent` loses `zoomHostCode` and `slackChannelId`; it gains `hostKey`.
- The Zoom S2S app needs only `meeting:write:invite_links:admin` (plus the webhook
  subscriptions); the `meeting:read:meeting:admin`, `user:read:user:admin`, and
  `user:read:list_users:admin` scopes added for the Zoom lookup can be removed.
- `CMS_TOKEN`, `CMS_GRAPHQL_URL`, `graphql`, and `graphql-request` are gone. _(Deferred, below.)_
- **2026-09-18 — CMS source restored as the interim default.** The Worker ships before the
  calendar is canonical, so `src/bots/reminders/sources/cms.ts` is back, registered as `cms`
  and set as `EVENT_SOURCE` in `wrangler.jsonc`. It maps onto the same model as the Google
  adapter: the Join Link rule is the shared `deriveJoinInfo` (`src/events.ts`, [0002](0002-join-info-union-and-invalid-events.md)), so a
  Zoom link without `eventZoomHostCode` is an invalid event, dropped and alerted; Craft's HTML
  descriptions go through `src/html-to-markdown.ts` (the migration converter, moved into
  `src/`), degrading to stripped text on an unsupported tag. `CMS_TOKEN`, `CMS_GRAPHQL_URL`,
  `graphql` and `graphql-request` are back with it. The Google side stays operable while
  `cms` is active (`/vc-bot-admin daily google`, `watch start`); the router drops Calendar
  pushes and the cron skips the watch bootstrap unless `google` is active. The cutover is
  `EVENT_SOURCE` → `"google"`; the removal above then happens for real —
  [#28](https://github.com/Virtual-Coffee/vc-bots/issues/28).
- virtualcoffee.io ADR 0014 has been reconciled with this decision (on PR #1579): the Host Code is
  `extendedProperties.private.hostCode`, an Event field kept where the bots read it; the calendar
  is workspace-readable, not public; the site's `/admin/events` is the only writer of `hostCode`
  (Google's UI cannot set extended properties) and requires one whenever the Join Link is a Zoom
  URL. The `joinLink` and `slackChannelId` private properties are retired on that side too.
- Calendar migration: `pnpm fix-calendar --apply` (`scripts/fix-calendar.ts`) sets `location`
  from the old `joinLink` property wherever they differ (the Morning/Afternoon Crowd series),
  deletes `joinLink`, and converts existing descriptions to Markdown; `hostCode` stays on every
  Zoom series. Dry-run by default.
