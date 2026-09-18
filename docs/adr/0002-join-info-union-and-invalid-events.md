# 0002 — Join Link as a `JoinInfo` union; invalid events are rejected at derivation

**Status:** Accepted (2026-09-16)

## Context

ADR 0001 made the Join Link the event's `location` and the host key a private calendar property,
and ruled that a Zoom event without a host key fails the run. `ReminderEvent` carried that as two
loose fields, `joinLink?: string | null` (URL or free text) and `hostKey?: string | null`, so
"Zoom link, no host key" was a legal value and every consumer had to re-derive what the link
*was* (`startsWith("http")`, `parseZoomMeetingId`) before rendering. The rule itself lived in
`reconcileStartingSoon` as a pre-check that threw — which also meant one bad calendar entry
black-holed the whole daily run, the weekly summary, and every push-driven `CalendarSync` pass,
and the event-admin mirror could still be built from a `ReminderEvent` that had slipped past it.

## Decision

- **`ReminderEvent.join` is a discriminated union** (`JoinInfo` in `src/events.ts`), replacing
  `joinLink` + `hostKey`:
  - `zoom` — `url`, `meetingId`, `hostKey`. The host key exists **only** here, so a Zoom link
    without one is unrepresentable. Still event-admin-mirror only; never logged.
  - `url` — any other http(s) link. Renders as the Join Event button.
  - `place` — free-text `location` (a room, a venue). Renders as a "Location:" line.
  - `none` — no Join Link.
  A `hostCode` on a non-Zoom event is dropped at derivation.
- **The rule is enforced where the Join Link is derived**: the Google adapter
  (`src/google/calendar.ts`). Mapping is total — `toReminderEvent` returns `event`, `skipped`
  (cancelled / all-day / bad start), or `invalid` (`zoom-no-host-key`).
- **Skip-and-alert, not fail-all.** `listEvents` drops `invalid` events, logs
  `calendar.event_rejected` (id, title, reason — no url, no key) and posts one `#bot-log` alert
  per listing. Every other event proceeds. The alert repeats on every listing until the calendar
  is fixed; no dedupe.
- **`getEvent` reports `{ kind: "invalid", reason }`** as a fourth `CalendarEventLookup` kind.
  `CalendarSync` treats it like `all-day`: no cancellation or reschedule notice, the id simply
  leaves the snapshot. (The adapter already alerted.)
- `reconcileStartingSoon` no longer validates. Senders and Block Kit builders switch on
  `join.kind`; the button is for `zoom` / `url`, the location line for `place` (public) or any
  non-`none` kind (admin mirror), the host-code line for `zoom` only.

## Consequences

- Amends 0001's "A Zoom event without a host key fails the run": it is now rejected at the
  source, and the run continues without it.
- The reminders and sync paths cannot observe a host-key-less Zoom event at all; the only
  surface is the `#bot-log` alert and the `invalid` lookup kind.
- `CalendarEventLookup` gains `invalid`; the calendar fake (`test/helpers/calendar-fake.ts`)
  can return it per id.
- A Zoom event that loses its host code mid-week disappears from the announced window
  silently for members (no cancellation notice) — by design, since it is still on the calendar;
  fixing the property restores it on the next listing.
