# CLAUDE.md

## What this is

One Cloudflare Worker (`vc-bots`) hosting VirtualCoffee's Slack/Zoom automation: the
co-working room, the new-member welcome, the App Home tab, event announcements, and the weekly
availability check-in. It runs on `workerd`: Web APIs only (`fetch`, `crypto.subtle`, `btoa`, `URLSearchParams`). ESLint
(`eslint.config.ts`) enforces the import and logging rules — a failing rule's message names the
reason; `docs/adr/0008-eslint-prettier-toolchain.md` is the toolchain.

## Commands

Done means `pnpm check` and `pnpm test` are both green — that is what CI runs. Everything else
is in `package.json` `scripts`; the non-obvious ones:

```bash
pnpm vitest run test/coworking-do.test.ts   # one test file
pnpm vitest -t "name of test"               # tests matching a name
pnpm cf-types                               # after a wrangler.jsonc binding change
pnpm gen:api-types                          # after editing specs/ or the operationId allow-list
pnpm specs:update                           # refresh the vendored provider specs (network)
```

Tests run inside `workerd` (`@cloudflare/vitest-pool-workers`), so Web Crypto, the Durable
Objects and bindings behave as in production; bindings and migrations come from
`wrangler.jsonc`. Network is stubbed by spying on `fetch` (`installFetchRecorder`,
`test/helpers/fetch-recorder.ts`); the DOs are driven with `runInDurableObject` /
`runDurableObjectAlarm` from `cloudflare:test`.

## Vocabulary

`CONTEXT.md` is the glossary. Use its terms — room message, open/ended card, standing invite,
retire, member/guest, invite link, join token, invalid event, starting-soon pair, event-admin
mirror, day message, sign-up sheet, seed reactions — in code, tests, commits and issues; `docs/agents/domain.md` says how.

## Request flow

`src/index.ts` is the entrypoint (`fetch` + `scheduled` cron; the latter goes to `runCron` in
`src/cron.ts`, whose `CRON_JOBS` map is the single owner of every cron string). `fetch` delegates to
`src/router.ts`, a plain `method + path` switch: `POST /zoom/webhook`
(`handleZoomWebhook`, `src/zoom/webhook.ts`), `POST /google/notify` (the calendar watch
callback), the three `POST /slack/*` routes (one path-agnostic `SlackApp` built per request
by `createSlackApp(env, publicBaseUrl)` in `src/slack/app.ts`, where every `.event()` /
`.action()` / `.command()` / `.viewSubmission()` registration lives — hand it the request
**unread**, `app.run` reads the body), `GET /join/<token>`, `/health` and `HEAD /`.

Two invariants, in order, on every provider route:

1. **Verify the signature against the raw body before parsing** — the Zoom route does it as
   its first step (`verifyZoomRequest`, HMAC through `src/crypto.ts`); `SlackApp` does it
   before dispatching.
2. **Answer the provider's URL-verification handshake**, then dispatch.

**ACK fast, work later.** Routes return `200` immediately and work in `ctx.waitUntil`. Every
Slack ack is a no-op, the lazy handler does the work, and replies go through
`src/slack/response.ts` only — `docs/adr/0004-slack-replies-ack-noop-lazy-handler-response-url.md`.
Failure paths with no user in front of them alert `#bot-log` through an explicit
`notifyBotLog` call — `docs/adr/0006-bot-log-alerting-policy.md`.

## Areas

**Co-working room** (`src/bots/coworking/`, `src/zoom/`). `CoworkingRoom` is a SQLite Durable
Object, one instance per Zoom meeting id (`env.COWORKING_ROOM.getByName(meetingId)`, re-exported
from `src/index.ts`); the webhook route drops events for any other meeting before a DO is
touched. The DO owns the session state machine and the join tokens and `enqueue`s everything
that touches the session or the room message (Zoom events, the alarm, admin announcements);
`RoomMessage` owns the channel message. Before changing `src/bots/coworking/**`,
`src/zoom/**` or their tests, read `docs/adr/0003-zoom-events-serialized-in-the-do.md` (why
a single instance is not race-free) and
`docs/adr/0009-room-message-owns-the-channel-message.md` (cards, retire chain, storage
pointers, the join flow). Block Kit layouts there are hand-tuned: keep them byte-for-byte
when moving code.

**Admin actions** (`src/bots/admin/`). One `AdminAction` union behind `runAdminAction`; the
`/vc-bot-admin` slash command and the button panel are adapters that parse, run and deliver.
A new admin operation starts in `actions.ts`, then the surfaces —
`docs/adr/0010-one-admin-action-union.md`.

**Event announcements** (`src/bots/reminders/`, `src/google/`, `src/bots/calendar-sync/`).
The daily/weekly cron jobs post the summaries and schedule each event's starting-soon pair;
`sendReminder` is shared with the slash command. Events come from the
`EVENT_SOURCE` registry (`reminders/source.ts`): `google` is the Google Calendar adapter behind
`CalendarPort`, with the `CalendarSync` DO keeping the watch (it serializes its own work through
`SerialQueue`, ADR 0003); `cms` (Craft GraphQL, `reminders/sources/cms.ts`) is the interim default
until the cutover (ADR 0001, issue #28). Before
changing any of it, read `docs/adr/0005-event-announcement-crons.md` (`CRON_JOBS` must
match `wrangler.jsonc` byte-for-byte — `test/cron.test.ts` enforces it),
`docs/adr/0001-event-model-join-link-and-host-key.md` and
`docs/adr/0002-join-info-union-and-invalid-events.md` (the event model), and
`docs/adr/0011-one-google-calendar-adapter-behind-calendarport.md` (the adapter and the
watch).

**Availability check-in** (`src/bots/availability/`). The Monday 13:00 UTC cron (and
`/vc-bot-admin availability`) posts the trio — intro message + Tuesday/Thursday day messages,
each seeded with the four role reactions plus `:x:` — to `SLACK_AVAILABILITY_CHANNEL_ID` (empty = feature
off); every `reaction_added` / `reaction_removed` on a day message re-renders its sign-up sheet.
Slack's reactions are the source of truth — `docs/adr/0013-slack-reactions-are-the-availability-source-of-truth.md`:
`AvailabilitySheet` (one instance per channel) stores only the day-message pointers and the
cached bot user id, and runs `post` and `refresh` through one `SerialQueue` (ADR 0003).
Layouts and the reaction → sheet projection are pure in `message.ts`. Never call the sheet a
roster — that word belongs to the co-working session.

**Provider HTTP.** Every Google and Zoom REST call goes through `createApiClient` in
`src/http/client.ts` — `openapi-fetch` typed by `src/generated/*.d.ts`, which
`pnpm gen:api-types` produces from the vendored specs in `specs/` (never hand-edit either).
Non-2xx answers are `ApiError` (`src/http/error.ts`). To call a new endpoint, add its
`operationId` to `scripts/gen-api-types.ts` and regenerate —
`docs/adr/0012-provider-wire-types-from-vendored-openapi-specs.md`.

**Slack client.** `createSlackClient(env)` for outbound calls with no inbound Slack request
(the DOs, the cron); inside `SlackApp` handlers it is the same client. Every Slack import
(client, Block Kit types, payload types) comes from `slack-cloudflare-workers`, which
re-exports `slack-edge` and `slack-web-api-client` —
`docs/adr/0007-static-slack-authorize-and-self-event-filter.md`.

## Credentials

Log event names and ids. These carry a credential and never go into `log` or `notifyBotLog`
fields: personal `join_url`s and the join tokens that resolve to them, the Zoom host key
(event-admin mirror only), `GOOGLE_SERVICE_ACCOUNT_KEY`, signed JWT assertions, access tokens,
and the calendar watch token.

## Conventions

- **Config vs secrets.** Non-secret config (channel ids, meeting id, log level) is
  `wrangler.jsonc` `vars`, typed by hand in `src/env.ts` — keep the two in sync and rerun
  `pnpm cf-types`. Secrets (`SLACK_BOT_TOKEN`, `*_SECRET`, …) go through `wrangler secret put`
  in prod and `.dev.vars` locally (`.dev.vars.example`).
- **Logging.** The leveled `log` from `src/log.ts` (`log.info("event.name", { key: val })`).
  The threshold is set per request/DO with `setLogLevel(env.LOG_LEVEL)`; each DO sets it in
  its constructor because it runs in its own isolate.

## Agent skills

- Issue tracker: GitHub issues in `Virtual-Coffee/vc-bots` via `gh` — `docs/agents/issue-tracker.md`.
- Triage labels: the five canonical roles, default strings — `docs/agents/triage-labels.md`.
- Domain docs: `CONTEXT.md` + `docs/adr/` at the root — `docs/agents/domain.md`.
- Code review: label a PR `greptile-review` (or `coderabbit-review` for CodeRabbit); Greptile's
  config is `.greptile/`.
