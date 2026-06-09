# vc-bots

VirtualCoffee's Slack/Zoom automation — a single Cloudflare Worker hosting the
co-working room, the new-member welcome, the App Home tab, and event reminders.

## What it does

| Bot | Trigger | Behavior |
| --- | --- | --- |
| **Co-working room** | Zoom webhooks + a Slack Join button | Keeps a live "open room" message in the co-working channel: who's in the room, a ☕ Join button that hands each member a personal Zoom invite link, and a stats summary when the meeting ends. |
| **Welcome** | Slack `team_join` event | DMs new members a welcome message. |
| **App Home** | Slack `app_home_opened` event | Publishes the bot's App Home tab. |
| **Event reminders** | Cron triggers | Pulls upcoming events from the VirtualCoffee CMS (GraphQL) and posts Block Kit reminders to the reminders channel. |

There's also a `/vc-bot-admin` slash command for manual previews and admin actions
(e.g. `coworking invite`).

## Architecture at a glance

Everything runs on Cloudflare's edge runtime (`workerd`) — **no `node:*` modules**, Web APIs
only (`fetch`, `crypto.subtle`, etc.).

**Request flow.** `src/index.ts` is the Worker entrypoint (`fetch` + `scheduled`). `fetch`
delegates to `src/router.ts`, a plain `method + path` switch over five routes: `POST
/zoom/webhook`, `POST /slack/events`, `POST /slack/interactivity`, `POST /slack/commands`, and
`GET /health`. Every route:

1. **Verifies the provider signature against the raw body first**, before parsing JSON
   (timing-safe HMAC via `crypto.subtle` in `src/crypto.ts`).
2. **ACKs fast, works later.** Slack and Zoom impose a ~3s response window, so routes return
   `200` immediately and run the real work via `ctx.waitUntil(...)`, replying through Slack's
   `response_url` when needed.

**The co-working room is the one stateful piece.** `CoworkingRoom`
(`src/bots/coworking/durable-object.ts`) is a SQLite-backed Durable Object, one instance per
Zoom meeting ID. Routing all of a meeting's webhooks through a single instance serializes them,
eliminating eventual-consistency races. Zoom `meeting.started` posts (or updates the standing
invite into) the open-room message; `participant_joined/left` edit its live presence list;
`meeting.ended` turns it into a stats summary and posts a fresh invite. A stale-session alarm
force-closes sessions whose `meeting.ended` webhook never arrived.

**Joining is per-user.** The message's Join button opens a modal that mints a personal Zoom
invite link (`src/zoom/invite-links.ts`) with the member's name pre-filled — no Zoom
registration involved (the meeting must *not* require registration). Correlating Zoom
participants back to Slack members is best-effort by display name via the DO's `member_link`
table; people who join another way show as external guests. Personal `join_url`s carry a join
token — they are never logged.

## Project layout

```
src/
  index.ts            Worker entrypoint: fetch + scheduled cron, re-exports the DO
  router.ts           method + path routing, signature verification, fast ACKs
  env.ts              hand-maintained Env interface (bindings, secrets, vars)
  crypto.ts           timing-safe HMAC helpers on crypto.subtle
  log.ts              leveled logger (threshold from LOG_LEVEL)
  bots/
    coworking/        the room: Durable Object, Zoom event handlers, Join modal, message blocks
    reminders/        cron dispatch, CMS GraphQL queries, Block Kit builders, html-to-mrkdwn
    welcome.ts        new-member welcome DM
    app-home.ts       App Home tab
    admin.ts          /vc-bot-admin slash command
  slack/              Slack client factory, signature verification, payload types
  zoom/               Zoom S2S OAuth, webhook verification, invite links, payload types
test/                 vitest suites that run inside real workerd (Miniflare)
```

## Getting started

Prerequisites: [pnpm](https://pnpm.io) and a Cloudflare account (for deploys; local dev just
needs wrangler, which is a dev dependency).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then fill in real secrets
pnpm dev                          # wrangler dev — local server on workerd
```

## Configuration

Config and secrets are split deliberately:

- **Non-secret config** lives in `wrangler.jsonc` `vars` and is typed in `src/env.ts`:
  `ZOOM_MEETING_ID`, `SLACK_COWORKING_CHANNEL_ID`, `ROOM_TITLE`,
  `SLACK_REMINDERS_CHANNEL_ID`, `CMS_GRAPHQL_URL`, `LOG_LEVEL`. After changing bindings or
  vars, rerun `pnpm cf-types` and keep `src/env.ts` in sync by hand.
- **Secrets** go via `wrangler secret put <NAME>` in production and `.dev.vars` locally (see
  `.dev.vars.example`): `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
  `ZOOM_WEBHOOK_SECRET_TOKEN`, `ZOOM_S2S_CLIENT_ID`, `ZOOM_S2S_CLIENT_SECRET`,
  `ZOOM_S2S_ACCOUNT_ID`, `CMS_TOKEN`.

### Provider setup

- **Slack app**: event subscriptions for `team_join` and `app_home_opened` pointed at
  `/slack/events`, interactivity at `/slack/interactivity`, and the `/vc-bot-admin` slash
  command at `/slack/commands`.
- **Zoom app**: webhook subscriptions for `meeting.started`, `meeting.ended`,
  `meeting.participant_joined`, and `meeting.participant_left` pointed at `/zoom/webhook`,
  plus a Server-to-Server OAuth app for the invite-link API. The subscription is
  account-wide, so events arrive for every meeting under the account — the router ignores
  any meeting that isn't `ZOOM_MEETING_ID`. The co-working meeting must **not** require
  registration — invite links depend on it.
- **Cron triggers** fire in **UTC**. The cron strings in `wrangler.jsonc` `triggers.crons`
  must stay byte-identical to `CRON_TO_KIND` in `src/bots/reminders/index.ts` — the fired
  cron string is the lookup key for the reminder kind.

## Development

```bash
pnpm dev          # wrangler dev — local server on workerd
pnpm test         # vitest run (inside the real workerd runtime via Miniflare)
pnpm typecheck    # tsc --noEmit
pnpm cf-types     # regenerate worker-configuration.d.ts after wrangler.jsonc changes

pnpm vitest run test/coworking-do.test.ts   # a single test file
pnpm vitest -t "name of test"               # tests matching a name
```

Tests run inside `workerd` via `@cloudflare/vitest-pool-workers`, so Web Crypto, the Durable
Object, and bindings behave exactly as in production. Network calls are stubbed by spying on
`fetch`; the DO is driven with `runInDurableObject` / `runDurableObjectAlarm` from
`cloudflare:test`.

Use the leveled `log` from `src/log.ts` (`log.info("event.name", { key: val })`), never bare
`console.*` — and never log personal `join_url`s.

## Deploying

```bash
# One-time: set production secrets
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put ZOOM_WEBHOOK_SECRET_TOKEN
wrangler secret put ZOOM_S2S_CLIENT_ID
wrangler secret put ZOOM_S2S_CLIENT_SECRET
wrangler secret put ZOOM_S2S_ACCOUNT_ID
wrangler secret put CMS_TOKEN

pnpm deploy
```

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — developer conventions and architecture invariants.
