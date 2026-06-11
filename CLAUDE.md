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
pnpm typecheck    # tsc --noEmit
pnpm cf-types     # regenerate worker-configuration.d.ts from wrangler.jsonc after binding changes
pnpm deploy       # wrangler deploy

pnpm vitest run test/coworking-do.test.ts   # a single test file
pnpm vitest -t "name of test"               # tests matching a name
```

Tests run inside `workerd` (via `@cloudflare/vitest-pool-workers`), so Web Crypto, the Durable
Object, and bindings behave exactly as in production. Bindings/migrations come from
`wrangler.jsonc`. Tests stub network by spying on `fetch` (see `test/coworking-do.test.ts`); use
`runInDurableObject` / `runDurableObjectAlarm` from `cloudflare:test` to drive the DO.

## Architecture

**Request flow.** `src/index.ts` is the Worker entrypoint (`fetch` + `scheduled` cron). `fetch`
delegates to `src/router.ts`, a plain `method + path` switch (no router lib) over ~4 routes:
`/zoom/webhook`, `/slack/events`, `/slack/interactivity`, `/slack/commands` (plus `/health`).

**Two invariants every route follows, in order:**

1. **Verify the provider signature against the *raw* body first**, before parsing JSON
   (`verifySlackRequest` / `verifyZoomRequest`). All HMAC goes through `src/crypto.ts` using
   `crypto.subtle` — never hand-roll a timing-safe compare.
2. **Handle the provider URL-verification handshake**, then dispatch.

**ACK fast, work later.** Slack/Zoom impose a ~3s response window. Routes return `200`
immediately and run the actual bot work via `ctx.waitUntil(...)` (Slack events, interactivity,
slash commands). Final user-facing replies go back through Slack's `response_url`
(`respondEphemeral`) rather than the HTTP response.

**Co-working room = the one stateful piece.** `CoworkingRoom` (`src/bots/coworking/durable-object.ts`)
is a SQLite-backed Durable Object, **one instance per Zoom meeting ID**, addressed with
`env.COWORKING_ROOM.getByName(meetingId)`. The Zoom webhook subscription is account-wide, so the
router drops events whose meeting ID isn't `ZOOM_MEETING_ID` (other meetings under the account)
before any DO is touched. Routing all of a meeting's webhooks through a single
instance serializes them, so there are no eventual-consistency races (a member_link row is always
written before the join that reads it). The DO must be re-exported from `src/index.ts` for the
runtime to bind it. Schema (`session` / `member_link` / `participant` / `invite_link`) is created
idempotently in `migrate()` under `blockConcurrencyWhile`. A stale-session `alarm()` force-closes sessions that
never received `meeting.ended`.

The room is a self-managed channel message (no native Slack Call widget): Zoom `meeting.started`
→ post (or update the standing invite into) the open-room message; `participant_joined/left` →
edit its live presence list; `meeting.ended` → edit into a stats summary + post a fresh invite.
Joining is per-user: the message's Join button mints a personal Zoom **invite link**
(`src/zoom/invite-links.ts`, name pre-filled — no registration, requires the meeting to not
require registration) and replies via `response_url` with an **ephemeral message** carrying
☕ Join / Cancel buttons; clicking either deletes the ephemeral (`delete_original`), so the
surface dismisses itself (a modal can't — Slack has no API to close one from a button click).
The ☕ Join url is the Worker's own `GET /join/<token>` redirect, built on `PUBLIC_BASE_URL`
(the virtualcoffee.io/bots Netlify rewrite; empty falls back to the request origin); tokens
live in the DO's `invite_link` table and expire with the Zoom link, keeping the token-bearing
Zoom url out of the Slack UI. ⚠️ Never `replace_original`/`delete_original` against the
*channel* button's `response_url` — its "original" is the shared room message. Correlation is best-effort by
display name via the `member_link` table (the webhook carries no registrant id for invite-link
joiners); uncorrelated people show as external guests. Personal `join_url`s and the redirect
tokens that resolve to them carry a join credential — **never log them**.

**Event announcements** (`src/bots/reminders/`) run from the cron `scheduled()` handler and
post to three channels: daily/weekly summaries → `SLACK_ANNOUNCEMENTS_CHANNEL_ID`; per-event
"Starting Soon" messages → `SLACK_EVENTS_CHANNEL_ID`, each mirrored (with extras like the Zoom
host code) → `SLACK_EVENTADMIN_CHANNEL_ID`. The daily run schedules each starting-soon pair for
start − 10 min via Slack `chat.scheduleMessage`, first deleting the bot's scheduled messages in
the window so re-runs reconcile instead of duplicating; on Mondays it skips its summary (the
weekly covers it) but still schedules. Event windows are computed in `America/New_York`. Events
come through the `EventSource` abstraction (`source.ts`); the CMS GraphQL adapter
(`sources/cms.ts`) is the only source today — a Google Calendar source is planned. ⚠️ The cron
strings in `CRON_TO_KIND` (`index.ts`) **must stay byte-identical to `triggers.crons` in
wrangler.jsonc** — that string is the lookup key mapping a fired cron to a reminder kind. Crons
fire in **UTC** and are **currently disabled**: `triggers.crons: []` is deliberate (deploying an
empty array deregisters crons already on Cloudflare; deleting the key would leave them running).
The same `sendReminder` is reused by the `/vc-bot-admin` slash command for manual runs/previews.

**Slack client.** Always `createSlackClient(env)` (wraps `slack-web-api-client`) —
**do not add `@slack/web-api`** (it isn't edge-compatible).

## Conventions

- **Config vs secrets.** Non-secret config (channel IDs, meeting ID, log level) lives in
  `wrangler.jsonc` `vars` and is typed in `src/env.ts` (`Env`). Secrets (`SLACK_BOT_TOKEN`,
  `*_SECRET`, etc.) go via `wrangler secret put` in prod and `.dev.vars` locally (see
  `.dev.vars.example`). `src/env.ts` is the hand-maintained `Env` the app imports; keep it in
  sync with `wrangler.jsonc` and rerun `pnpm cf-types`.
- **Logging.** Use the leveled `log` from `src/log.ts` (`log.info("event.name", { key: val })`),
  not bare `console.*`. Threshold is set per request/DO via `setLogLevel(env.LOG_LEVEL)`; the DO
  sets it in its own constructor since it runs in a separate isolate.
- **TS is strict** with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` — use
  `import type` for type-only imports.
- `slackify-html` is **edge-incompatible** (throws on workerd); a local `html-to-mrkdwn`
  converter replaces it. Don't re-add it.
