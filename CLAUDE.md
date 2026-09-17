# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker (`vc-bots`) hosting all of VirtualCoffee's Slack/Zoom automation:
the co-working room, the new-member welcome, the App Home tab, and event announcements. Everything
runs on the edge runtime (`workerd`) — **no `node:*` modules**. Use Web APIs only: `fetch`,
`crypto.subtle`, `btoa`, `URLSearchParams`, etc.

## Commands

```bash
pnpm dev          # wrangler dev — local server on workerd
pnpm test         # vitest run (all tests, inside the real workerd runtime via Miniflare)
pnpm typecheck    # tsc --noEmit (TS 7 / tsgo)
pnpm check        # what CI runs: format:check + lint + typecheck + knip
pnpm lint:fix     # eslint --fix;  pnpm format = prettier --write
pnpm cf-types     # regenerate worker-configuration.d.ts from wrangler.jsonc after binding changes
pnpm deploy       # wrangler deploy

pnpm vitest run test/coworking-do.test.ts   # a single test file
pnpm vitest -t "name of test"               # tests matching a name
```

Tests run inside `workerd` (via `@cloudflare/vitest-pool-workers`), so Web Crypto, the Durable
Object, and bindings behave exactly as in production. Bindings/migrations come from
`wrangler.jsonc`. Tests stub network by spying on `fetch` (`installFetchRecorder` in
`test/helpers/fetch-recorder.ts` records every call and answers with canned Slack/Zoom responses);
use `runInDurableObject` / `runDurableObjectAlarm` from `cloudflare:test` to drive the DO. The
room message has its own unit suite (`test/room-message.test.ts`) against the fake channel port in
`test/helpers/room-channel-fake.ts` — layout and pointer assertions belong there, not in the DO suite.

## Architecture

**Request flow.** `src/index.ts` is the Worker entrypoint (`fetch` + `scheduled` cron). `fetch`
delegates to `src/router.ts`, a plain `method + path` switch (no router lib) over the provider
routes `/zoom/webhook`, `/slack/events`, `/slack/interactivity`, `/slack/commands`, plus
`GET /join/<token>` (the co-working join redirect), `/health` and `HEAD /`. `POST /zoom/webhook`
is `handleZoomWebhook` in `src/zoom/webhook.ts` (the router only dispatches to it).
All three `POST /slack/*` routes delegate to one path-agnostic `SlackApp`
(`slack-cloudflare-workers`), built per request by `createSlackApp(env, publicBaseUrl)` in
`src/slack/app.ts` — handler registrations (`.event()` / `.action()` / `.command()`) live there.
Hand the request to `app.run(req, ctx)` **unread** (it reads the body itself).

**Two invariants every route follows, in order:**

1. **Verify the provider signature against the *raw* body first**, before parsing JSON. The
   Zoom route does this as its first step in `src/zoom/webhook.ts` (`verifyZoomRequest`, HMAC
   via `src/crypto.ts` / `crypto.subtle` — never hand-roll a timing-safe compare); the Slack
   routes get it from
   `SlackApp`, which verifies before dispatching listeners.
2. **Handle the provider URL-verification handshake**, then dispatch (`SlackApp` answers
   Slack's `url_verification` itself).

**ACK fast, work later** (ADR 0004). Routes return `200` immediately and do the work in
`ctx.waitUntil(...)`; for Slack every registration in `src/slack/app.ts` ACKs with a no-op and
works in the lazy handler. Every lazy handler is wrapped by `lazy()` there: slack-edge hands the
lazy promise to `waitUntil` with no try/catch, so the wrapper is what turns an escaped rejection
into a `slack.lazy_failed` alert in `#bot-log`. Replies go through `src/slack/response.ts` only —
`respondEphemeral` against any `response_url`; `replaceEphemeral` / `deleteOriginal` only against
per-user ephemerals (the admin panel, the join ephemeral), never the shared room message's. Not
the framework's `context.respond`.

**Admin actions (`src/bots/admin/`).** One `AdminAction` union (`actions.ts`) backs both admin
surfaces: `runAdminAction(env, userId, action)` applies the workspace-admin gate, runs the
operation inside the single try/catch, and returns an `AdminResult` (`denied` / `failed` / the
outcome); `adminReplyText(result)` is the reply line. `slash.ts` (`/vc-bot-admin` with
`daily|weekly [source]`, `welcome [@user]`, `home`, `coworking open|close`,
`watch status|start|stop`) and `panel.ts` (the no-args button panel + its modals) are
adapters: parse their payload into an action, run it, deliver the result. Neither adapter gates or catches on its own — the only
direct `guardAdmin` calls are for work that runs no action (the slash usage/panel replies, the
panel buttons that open a modal). Put a new admin operation in `actions.ts`, then wire the
surfaces.

**Modals (`.viewSubmission`).** Panel buttons open modals via
`client.views.open({ trigger_id, view })`, and submits run through
`.viewSubmission(callbackId, ack, lazy)` registrations in `src/slack/app.ts`. The view ack is
an **empty `async () => {}`** — returning void closes the modal (the shared `ack` const's
`AckResponse` type doesn't satisfy the view ack). A `view_submission` payload carries **no
`response_url`**, so the panel's travels into the modal as `private_metadata`
(`JSON.stringify({ response_url })`) and back out on submit; the handler then
`replaceEphemeral`s the panel with output (reminder counts) or `deleteOriginal`s it when the
result is self-verifiable in a channel/Home/DM.

**Co-working room = the one stateful piece.** `CoworkingRoom` (`src/bots/coworking/durable-object.ts`)
is a SQLite-backed Durable Object, **one instance per Zoom meeting ID**, addressed with
`env.COWORKING_ROOM.getByName(meetingId)`. The Zoom webhook subscription is account-wide, so the
router drops events whose meeting ID isn't `ZOOM_MEETING_ID` (other meetings under the account)
before any DO is touched, then ACKs and dispatches in `ctx.waitUntil`. ⚠️ A single instance does
**not** make the handlers race-free: input gates only cover storage ops, so other requests are
delivered while a handler awaits a Slack `fetch`. The DO therefore queues everything that touches
the session state machine or the room message itself (`enqueue` — Zoom events, the alarm, admin
announcements); the join-token RPCs only touch `member_link` / `invite_link` and stay outside so
the Join button isn't slowed; `coworking.queue.wait` (`info`) logs whenever something actually
queued behind in-flight work. See `docs/adr/0003-zoom-events-serialized-in-the-do.md`. The DO must
be re-exported from `src/index.ts` for the runtime to bind it. Schema (`session` / `member_link` / `participant` / `invite_link`) is created
idempotently in `migrate()` under `blockConcurrencyWhile`. A stale-session `alarm()` force-closes sessions that
never received `meeting.ended`. The DO owns only the session state machine and the join tokens;
everything about the channel message is delegated to `RoomMessage`. Its two outward edges are
swappable private fields: `inviteLinks: InviteLinkPort` (`createZoomInviteLinkPort` in
`src/zoom/invite-links.ts` — S2S token + `createInviteLink`) and `roomMessage: RoomMessage`; the
DO suite installs `test/helpers/invite-link-fake.ts` and `installRoomChannelFake`
(`test/helpers/room-channel-fake.ts`) on every `runInDurableObject` entry, so it never touches
`fetch` — adapter wire tests live in `test/zoom-invite-links.test.ts`.

**The room message** (`RoomMessage`, `src/bots/coworking/room-message.ts`) is the single
self-managed channel message per session (no native Slack Call widget), and the module owns its
cards, copy, and cross-session pointers. The DO calls `open` / `showPresence` / `close` /
`announceOpen` / `announceClose`; Slack sits behind the three-call `RoomChannelPort` (post /
update / delete on the co-working channel — `createSlackRoomChannelPort` is the adapter, and it
classifies `message_not_found` / `channel_not_found` as `"vanished"` so a hand-deleted card never
wedges the room). Lifecycle: `meeting.started` → `open` **always posts** a fresh open card (never
an edit — only a fresh post makes Slack notify the channel); `participant_joined/left` →
`showPresence` edits the presence list; `meeting.ended` → `close` edits it into the ended card,
which carries the **standing invite** and is remembered as the *last closed card*. The next room
message (`open` for a session start, `announceOpen` for an announcement) retires the previous card
itself, right after posting: it re-renders that card with `{ invite: false }`, closes any lingering
open announcement (without invite), and runs the one-shot legacy `idle_invite_ts` delete — so
exactly one standing invite exists at a time. Retiring is best-effort: each step is try/caught on
its own, warns `coworking.room_msg.retire_failed`, and keeps its pointer for the next takeover to
retry (the legacy delete stays one-shot) — it never blocks the session. Pointers live in DO
storage under `room_message:open` (the live session's card, `{ ts, startedAtMs }`),
`last_closed_message` (the cached `SessionStats` — `participant` rows are deleted at close, so the
roster can't be re-derived from SQL) and `room_message:announcement`; the DO never touches them.
Announcements (`/vc-bot-admin coworking open|close`) join the same chain: `announceClose` renders
the full ended card (peak 0, no roster) with the invite, and it becomes the last closed card.
RoomMessage keeps the open card under `room_message:open` next to the other two pointers —
`open` writes it, `showPresence`/`close` read it — so the DO never sees a message ts.
Block Kit layouts are private to `room-message.ts` and hand-tuned — keep them byte-for-byte when
moving code. Joining is per-user: the message's Join button mints a personal Zoom **invite link**
(`src/zoom/invite-links.ts`, name pre-filled — no registration, requires the meeting to not
require registration) and replies via `response_url` with an **ephemeral message** carrying
☕ Join / Cancel buttons (`buildJoinEphemeralAttachments` in `src/bots/coworking/join.ts`);
clicking either deletes the ephemeral (`delete_original`), so the surface dismisses itself (a
modal can't — Slack has no API to close one from a button click).
The ☕ Join url is the Worker's own `GET /join/<token>` redirect, built on `PUBLIC_BASE_URL`
(the virtualcoffee.io/bots Netlify rewrite; empty falls back to the request origin); tokens
live in the DO's `invite_link` table and expire with the Zoom link, keeping the token-bearing
Zoom url out of the Slack UI. ⚠️ Never `replace_original`/`delete_original` against the
*channel* button's `response_url` — its "original" is the shared room message. Correlation is best-effort by
display name via the `member_link` table (the webhook carries no registrant id for invite-link
joiners), only within the invite TTL, and a member whose Slack profile name couldn't be read
never correlates; uncorrelated people show as external guests. Personal `join_url`s and the redirect
tokens that resolve to them carry a join credential — **never log them**.

**Event announcements** (`src/bots/reminders/`) run from the cron `scheduled()` handler and
post to three channels: daily/weekly summaries → `SLACK_ANNOUNCEMENTS_CHANNEL_ID`; per-event
"Starting Soon" messages → `SLACK_EVENTS_CHANNEL_ID`, each mirrored (with the Zoom host key)
→ `SLACK_EVENTADMIN_CHANNEL_ID`. The daily run schedules each starting-soon pair for
start − 10 min via Slack `chat.scheduleMessage`, first deleting the bot's scheduled messages in
the window so re-runs reconcile instead of duplicating; on Mondays it skips its summary (the
weekly covers it) but still schedules. Event windows are computed in `America/New_York`. Events
come through the `EventSource` abstraction (`source.ts`); Google Calendar is the only registered
source and the `EVENT_SOURCE` default. All Google Calendar HTTP lives in **one adapter**,
`createGoogleCalendarPort` in `src/google/calendar.ts`, behind the `CalendarPort` seam
(`listEvents` / `getEvent` / `watch` / `stopChannel`); the reminders source is its `listEvents`,
and the `CalendarSync` DO (`src/bots/calendar-sync/`) takes the port as an injected field so
tests swap in `test/helpers/calendar-fake.ts`; its snapshot diff is pure in `diff.ts`
(`departedUpcoming` / `diffSnapshot`) and unit-tested without the DO. The adapter caches its
access token per instance (minted by the pure `fetchGoogleAccessToken` in `src/google/auth.ts`,
service-account JWT-bearer).
The shared event model (`ReminderEvent`, `EventRange`) is `src/events.ts`. Per `docs/adr/0001`: the Join Link
is the event's `location` (video `conferenceData` is the fallback; a `private.joinLink` property
is ignored), descriptions are **Markdown** rendered with `slackify-markdown`, and the host key is
the event's `extendedProperties.private.hostCode` (the calendar is private; the Zoom API stopped
returning `host_key` in 2022, so it cannot be looked up at send time). `ReminderEvent.join` is
a discriminated union (`JoinInfo` in `src/events.ts`: `zoom` | `url` | `place` | `none`) and
only `zoom` carries `hostKey`; the Google adapter **rejects** a Zoom Join Link without a host
key at derivation (dropped from `listEvents`, alerted to `#bot-log`, `getEvent` → `invalid`) so
every other event proceeds (`docs/adr/0002`). The host key goes only to the
event-admin mirror — **never log it**. Crons fire
in **UTC** and are **live** (`0 12 * * *` daily, `0 12 * * MON` weekly); `CRON_TO_KIND`
(`src/bots/reminders/index.ts`) must match `triggers.crons` in wrangler.jsonc byte-for-byte,
weekdays spelled `MON`/`SUN` (Cloudflare is Quartz-style), disable by deploying
`triggers.crons: []` — `test/reminders-cron.test.ts` enforces the first two (ADR 0005). The
same `sendReminder` is reused by the `/vc-bot-admin` slash command for manual runs; it accepts
an optional source arg (e.g. `daily google`) naming a registered source; cron always uses
`EVENT_SOURCE`. Failure paths with no other surface (the cron run, the Zoom webhook → DO
dispatch, the join flow, and any Slack lazy handler that rejects — `slack.lazy_failed`) alert
`#bot-log` via an explicit `notifyBotLog` call (`src/slack/notify.ts`; a no-op when
`SLACK_BOTLOG_CHANNEL_ID` is empty) — never hooked into `log` (ADR 0006).

**Slack client.** Always `createSlackClient(env)` for outbound calls with no inbound Slack
request (the CoworkingRoom DO, the cron reminders); inside `SlackApp` handlers it's the same
client either way. `createSlackApp` uses a static `authorize` (fixed token, empty bot ids) with
`ignoreSelfEvents: false` (ADR 0007). All Slack imports (client, Block Kit types, payload types) come from
`slack-cloudflare-workers` (which re-exports `slack-edge` and `slack-web-api-client`) —
**do not add `@slack/web-api`** (it isn't edge-compatible) and don't depend on
`slack-web-api-client` directly (it's transitive; pnpm's strict `node_modules` would break).

## Conventions

- **Config vs secrets.** Non-secret config (channel IDs, meeting ID, log level) lives in
  `wrangler.jsonc` `vars` and is typed in `src/env.ts` (`Env`). Secrets (`SLACK_BOT_TOKEN`,
  `*_SECRET`, etc.) go via `wrangler secret put` in prod and `.dev.vars` locally (see
  `.dev.vars.example`). `src/env.ts` is the hand-maintained `Env` the app imports; keep it in
  sync with `wrangler.jsonc` and rerun `pnpm cf-types`. ⚠️ Google service-account JSON
  (`GOOGLE_SERVICE_ACCOUNT_KEY`), signed JWT assertions, and access tokens are credentials —
  never log them.
- **Logging.** Use the leveled `log` from `src/log.ts` (`log.info("event.name", { key: val })`),
  not bare `console.*`. Threshold is set per request/DO via `setLogLevel(env.LOG_LEVEL)`; the DO
  sets it in its own constructor since it runs in a separate isolate.
- **TS is strict** with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` — use
  `import type` for type-only imports.
- **Lint enforces the invariants above** (`eslint.config.ts`): `node:*` imports,
  `@slack/web-api` / `slack-web-api-client` / `slackify-html`, and bare `console.*` fail
  `pnpm lint` with a message naming the rule here. Two `typescript` installs are deliberate —
  `typescript` (TS 6 API, for ESLint/knip) and `@typescript/native` (TS 7, the `tsc` bin);
  ADR 0008 says when to collapse them.
- `slackify-html` is **edge-incompatible** (throws on workerd). Don't re-add it. Event
  descriptions are Markdown, rendered with `slackify-markdown` (pure ESM, runs on workerd);
  there is no HTML path.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `Virtual-Coffee/vc-bots`, managed with the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
