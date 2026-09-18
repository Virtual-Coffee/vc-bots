# vc-bots

VirtualCoffee's Slack/Zoom automation — a single Cloudflare Worker hosting the
co-working room, the new-member welcome, the App Home tab, and event announcements.

## What it does

| Bot | Trigger | Behavior |
| --- | --- | --- |
| **Co-working room** | Zoom webhooks + a Slack Join button | Posts a fresh "open room" message in the co-working channel each time a session starts (so the channel gets notified): who's in the room, a ☕ Join button that hands each member a personal Zoom invite link, and a stats summary when the meeting ends — which also carries the button that starts the next session. |
| **Welcome** | Slack `team_join` event | DMs new members a welcome message. |
| **App Home** | Slack `app_home_opened` event | Publishes the bot's App Home tab. |
| **Availability check-in** | Cron trigger (Mondays) + Slack reaction events | Posts the Monday trio to the hosts channel — an `@channel` intro with the role legend, then a Tuesday and a Thursday message seeded with the five role emoji — and edits each day message as people react so every role line lists who signed up. Slack's reactions are the source of truth (ADR 0013); `/vc-bot-admin availability` posts it on demand. |
| **Event announcements** | Cron triggers | Pulls upcoming events from the VirtualCoffee Google Calendar (service-account auth; the Join Link is the event's `location`, descriptions are Markdown), posts daily/weekly summaries to the announcements channel, and schedules a per-event "Starting Soon" message (start − 10 min) into the events channel, mirrored to the event-admin channel with the Zoom host key (read from the event's private `hostCode` calendar property). Crons are live (daily + weekly); `/vc-bot-admin` can also fire a run manually. |

There's also a `/vc-bot-admin` slash command for manual previews and admin actions
(`daily` / `weekly [source]` to fire an announcement run now, `welcome [@user]`, `home`,
`coworking open|close`, `watch status|start|stop` for the Calendar push channel,
`availability` to post this week's check-in); run it with
no arguments for a button panel of the same actions.

## Architecture at a glance

Everything runs on Cloudflare's edge runtime (`workerd`) — **no `node:*` modules**, Web APIs
only (`fetch`, `crypto.subtle`, etc.).

**Request flow.** `src/index.ts` is the Worker entrypoint (`fetch` + `scheduled`). `fetch`
delegates to `src/router.ts`, a plain `method + path` switch over seven routes: `POST
/zoom/webhook`, `POST /slack/events`, `POST /slack/interactivity`, `POST /slack/commands`,
`POST /google/notify` (Google Calendar push notifications), `GET /join/<token>` (the co-working
join redirect — the token itself is the credential, so there's no signature to check), and
`GET /health`. Every provider route:

1. **Verifies the provider signature against the raw body first**, before parsing JSON
   (timing-safe HMAC via `crypto.subtle` in `src/crypto.ts`) — except `/google/notify`, which
   instead authenticates by the per-channel `X-Goog-Channel-Token` header (the body is empty).
2. **ACKs fast, works later.** Slack and Zoom impose a ~3s response window, so routes return
   `200` immediately and run the real work via `ctx.waitUntil(...)`, replying through Slack's
   `response_url` when needed.

**The co-working room is the one stateful piece.** `CoworkingRoom`
(`src/bots/coworking/durable-object.ts`) is a SQLite-backed Durable Object, one instance per
Zoom meeting ID. The DO queues its own handlers so a join can't interleave with the session start
(`docs/adr/0003`). The DO keeps the session state; the room message itself
lives in `RoomMessage` (`src/bots/coworking/room-message.ts`), behind a small Slack port. Zoom
`meeting.started` **posts a new** open card — a fresh post is what makes Slack notify the channel
that the room opened, where an edit would be silent; `participant_joined/left` edit its live
presence list; `meeting.ended` turns it into an ended card that also carries the "start a new
session" button. That ended card *is* the standing invite: the next room message (a session start
or an admin announcement) posts its own message and retires the button off the old one, so exactly
one standing invite exists at a time. A stale-session alarm force-closes sessions whose
`meeting.ended` webhook never arrived.

**The availability check-in is the other stateful piece**, and deliberately a thin one.
`AvailabilitySheet` (`src/bots/availability/durable-object.ts`), one instance per availability
channel, stores only the two day-message pointers (with the post time) and the cached bot user
id; every `reaction_added` / `reaction_removed`
on a day message re-reads `reactions.get` and rewrites the message's sign-up sheet. Posting
and refreshing share the DO's `SerialQueue` (a reaction that lands mid-post waits for the new
pointers), and refreshes queued for the same message coalesce. The layouts and
the reaction → sheet projection are pure functions in `src/bots/availability/message.ts`.

**Joining is per-user.** The message's Join button mints a personal Zoom invite link
(`src/zoom/invite-links.ts`) with the member's name pre-filled — no Zoom registration involved
(the meeting must *not* require registration) — and answers with an ephemeral message holding
☕ Join / Cancel buttons; clicking either deletes the ephemeral (☕ Join also opens Zoom), so the
surface dismisses itself. The button's url is the Worker's own `GET /join/<token>` redirect,
which 302s to the personal link — the token-bearing Zoom url never appears in the Slack UI.
The redirect is surfaced under `PUBLIC_BASE_URL` (the `virtualcoffee.io/bots` Netlify rewrite
in front of the Worker); when unset it falls back to the request origin.
Correlating Zoom participants back to Slack members is best-effort by display name via the DO's
`member_link` table; people who join another way show as external guests. Personal `join_url`s
(and the redirect tokens that resolve to them) carry a join credential — they are never logged.

## Project layout

```
src/
  index.ts            Worker entrypoint: fetch + scheduled cron, re-exports the DOs
  router.ts           method + path routing, signature verification, fast ACKs
  cron.ts             the cron schedule: cron string → job (single owner of the strings)
  env.ts              hand-maintained Env interface (bindings, secrets, vars)
  crypto.ts           timing-safe HMAC helpers on crypto.subtle
  log.ts              leveled logger (threshold from LOG_LEVEL)
  events.ts           source-agnostic event model (ReminderEvent, EventRange)
  bots/
    availability/     weekly check-in: Durable Object (message pointers, post/refresh queue),
                      pure message builders + reaction → sign-up-sheet projection, Worker glue
    calendar-sync/    Durable Object: Calendar watch lifecycle + change notices (over CalendarPort)
    coworking/        the room: Durable Object (session state), RoomMessage (the channel message
                      + its Slack port), Zoom event helpers, join flow + ephemeral
    reminders/        event-source registry, Block Kit builders, the starting-soon.ts
                      scheduled pair
    welcome.ts        new-member welcome DM + App Home tab
    admin/            /vc-bot-admin: actions.ts (the AdminAction union, gate + error handling),
                      slash.ts (the text command), panel.ts (the button panel + its modals)
  slack/
    app.ts            the per-request SlackApp: event/action/command/viewSubmission handlers
    client.ts         Slack client factory (createSlackClient / createSlackApp)
    notify.ts         #bot-log error alerts (notifyBotLog)
    response.ts       ephemeral reply helpers over response_url
  google/             service-account auth + the Google Calendar adapter (CalendarPort)
  zoom/               Zoom S2S OAuth, webhook verification, invite links, payload types
    webhook.ts        POST /zoom/webhook: verify → url_validation → meeting filter → the DO
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
  `ZOOM_MEETING_ID`, `PUBLIC_BASE_URL` (join links surface under the `virtualcoffee.io/bots`
  Netlify rewrite), `SLACK_COWORKING_CHANNEL_ID`, `ROOM_TITLE`, `WELCOME_MAINTAINER_IDS`
  (maintainers @-mentioned in the welcome message and App Home), the three announcement
  channels — `SLACK_EVENTS_CHANNEL_ID` (starting-soon messages),
  `SLACK_ANNOUNCEMENTS_CHANNEL_ID` (daily/weekly summaries), `SLACK_EVENTADMIN_CHANNEL_ID`
  (admin mirror with the Zoom host key) — `SLACK_AVAILABILITY_CHANNEL_ID` (the hosts channel
  for the Monday availability check-in; empty turns the feature off), `SLACK_BOTLOG_CHANNEL_ID` (private `#bot-log`
  channel for error alerts; empty disables alerting and the bot must be invited before it can
  post), `EVENT_SOURCE` (active event source: `"cms"`, the interim default until the Google
  cutover, or `"google"` — see `docs/adr/0001`), `CMS_GRAPHQL_URL`, `GOOGLE_CALENDAR_ID`, and
  `LOG_LEVEL`. After changing bindings or vars, rerun `pnpm cf-types`
  and keep `src/env.ts` in sync by hand.
- **Secrets** go via `wrangler secret put <NAME>` in production and `.dev.vars` locally (see
  `.dev.vars.example`): `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
  `ZOOM_WEBHOOK_SECRET_TOKEN`, `ZOOM_S2S_CLIENT_ID`, `ZOOM_S2S_CLIENT_SECRET`,
  `ZOOM_S2S_ACCOUNT_ID` (the S2S app needs only `meeting:write:invite_links:admin`),
  `CMS_TOKEN` (Craft GraphQL bearer token, interim), `GOOGLE_SERVICE_ACCOUNT_KEY` (Google Calendar service account), `GOOGLE_WATCH_TOKEN` (any
  random string ≤256 chars; Google echoes it back on every Calendar push notification and the
  `/google/notify` route drops notifications that don't carry it).

### Provider setup

- **Slack app**: event subscriptions for `team_join`, `app_home_opened`, `reaction_added`
  and `reaction_removed` pointed at `/slack/events`, interactivity at `/slack/interactivity`,
  and the `/vc-bot-admin` slash command at `/slack/commands`. The availability check-in needs
  the `reactions:read` and `reactions:write` bot scopes (reinstall the app after adding them)
  and the bot invited to `SLACK_AVAILABILITY_CHANNEL_ID`.
- **Zoom app**: webhook subscriptions for `meeting.started`, `meeting.ended`,
  `meeting.participant_joined`, and `meeting.participant_left` pointed at `/zoom/webhook`,
  plus a Server-to-Server OAuth app for the invite-link API (`meeting:write:invite_links:admin`).
  The subscription is account-wide, so events arrive for every meeting under the account — the
  router ignores any meeting that isn't `ZOOM_MEETING_ID`. The co-working meeting must **not**
  require registration — invite links depend on it.
- **Google Calendar**: the events calendar is **private** (owners, the service account, and
  workspace-domain readers only). The Join Link is each event's `location`; the Zoom host key is
  the event's `extendedProperties.private.hostCode`, which the Google UI can't edit — set it
  through the Calendar API (the website admin page, once it lands). A Zoom-link event without a
  `hostCode` is skipped with a `#bot-log` alert; other events proceed (see `docs/adr/0002`).
- **Cron triggers** fire in **UTC**. The cron strings in `wrangler.jsonc` `triggers.crons`
  must stay byte-identical to the `CRON_JOBS` keys in `src/cron.ts` — the fired cron string
  is the lookup key for the job (`test/cron.test.ts` enforces it). Three crons: `0 12 * * *`
  (daily announcements) and `0 12 * * MON` (weekly announcements) at 12:00 UTC (8am EDT / 7am
  EST), and `0 13 * * MON` (availability check-in) at 13:00 UTC (9am EDT / 8am EST). Cloudflare parses
  weekdays Quartz-style (`1` = Sunday … `7` = Saturday, unlike Unix cron's `0` = Sunday), so
  weekdays are spelled as 3-letter abbreviations to keep the intended day unambiguous. The per-event
  starting-soon messages need no extra cron granularity because the daily run schedules them
  via Slack's `chat.scheduleMessage`. The crons are **live**. To disable, set `triggers.crons`
  to an empty array `[]` — deploying `[]` deregisters any crons already on Cloudflare, whereas
  deleting the key would leave them running.

## Development

```bash
pnpm dev          # wrangler dev — local server on workerd
pnpm test         # vitest run (inside the real workerd runtime via Miniflare)
pnpm typecheck    # tsc --noEmit
pnpm check        # format:check + lint + typecheck + knip — what CI runs on every PR
pnpm lint:fix     # eslint --fix;  pnpm format = prettier --write
pnpm cf-types     # regenerate worker-configuration.d.ts after wrangler.jsonc changes

pnpm vitest run test/coworking-do.test.ts   # a single test file
pnpm vitest -t "name of test"               # tests matching a name

pnpm fix-calendar [--apply]   # one-off Join Link / Markdown calendar migration (ADR 0001);
                              # dry-run by default, needs GOOGLE_SERVICE_ACCOUNT_KEY in the env
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
wrangler secret put CMS_TOKEN   # interim, until the Google cutover (#28)
wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
wrangler secret put GOOGLE_WATCH_TOKEN

pnpm deploy
```

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — developer conventions and architecture invariants.
