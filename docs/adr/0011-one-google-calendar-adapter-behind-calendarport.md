# 0011 — All Google Calendar HTTP in one adapter behind `CalendarPort`; the sync DO takes it injected

**Status:** Accepted (2026-09-17)

## Context

The Calendar is read from two places: the event announcements (a window of events for the
daily / weekly summaries and the starting-soon pairs) and the calendar watch (a push channel
whose notifications diff the live window against a snapshot to catch cancellations and
reschedules). Both need a service-account access token, both parse the same event shape, and
both must apply the same rules for the Join Link and the host key (ADR 0001) and for invalid
events (ADR 0002). Written twice, those rules diverged.

## Decision

- **`createGoogleCalendarPort(env)` (`src/google/calendar.ts`) is the only module that talks
  to the Google Calendar API**, behind the `CalendarPort` seam: `listEvents(range)` (timed,
  non-cancelled, valid events — invalid ones dropped and alerted), `getEvent(id)` (`live` /
  `cancelled` / `invalid`; transient failures throw rather than masquerade as a deletion),
  `watch(address)` and `stopChannel(channelId, resourceId)` (`stopped` / `gone` / `failed`,
  never thrown). `toReminderEvent` is the one mapping from the wire shape to `ReminderEvent`
  (`src/events.ts`).
- **The adapter caches its access token per instance**, minted by the pure
  `fetchGoogleAccessToken` in `src/google/auth.ts` (service-account JWT bearer grant, Web
  Crypto only) and refreshed ahead of expiry.
  Amended by [0012](0012-provider-wire-types-from-vendored-openapi-specs.md): the adapter and
  the token exchange call through `openapi-fetch` clients typed by generated wire types.
- **Announcements reach the Calendar through `EventSource` (`src/bots/reminders/source.ts`)**:
  a registry of named sources — Google is the only one, and the `EVENT_SOURCE` default. Cron
  always uses the configured source; `/vc-bot-admin daily|weekly [source]` may name a
  registered one. `reminderRange` computes the window in `America/New_York` (`EASTERN`).
- **The `CalendarSync` Durable Object (`src/bots/calendar-sync/durable-object.ts`) takes the
  port as an injected field.** It is a singleton (`env.CALENDAR_SYNC.getByName("default")`)
  that serializes push notifications and the daily cron's `ensureWatch` through one instance.
  It owns the watch lifecycle (register, renew a day before the 7-day expiry via its alarm,
  stop) and the snapshot; the diff is pure in `diff.ts` (`departedUpcoming` / `diffSnapshot`)
  and unit-tested without the DO. Tests swap in `test/helpers/calendar-fake.ts`.
- **`POST /google/notify` (`src/router.ts`) is the push callback.** It authenticates the
  per-channel token (`GOOGLE_WATCH_TOKEN`), drops the `sync` handshake and pushes from a
  non-Google active source, ACKs `200`, and hands the channel id to the DO in
  `ctx.waitUntil` — alerting `#bot-log` (`google.notify.failed`) if that dispatch rejects
  (ADR 0006).

## Consequences

- A Calendar rule (what counts as a Join Link, what makes an event invalid, how a range is
  queried) changes in one file and both readers follow.
- A second source means a second `EventSource` entry, not a second adapter shape;
  `CalendarSync` stays Google-only because the watch is a Google feature.
- The service-account JSON (`GOOGLE_SERVICE_ACCOUNT_KEY`), the signed JWT assertion, the access
  token, and the watch token / address are credentials: they never appear in log or alert
  fields. The watch channel id is a random uuid and is safe to log.
