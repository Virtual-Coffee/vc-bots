# VirtualCoffee Bots — Architecture & Design

**Status:** Draft for review
**Date:** 2026-05-28
**Repo:** `virtual-coffee/bots` (greenfield)

This repo is a fresh, ground-up home for VirtualCoffee's Slack/Zoom bots. It **replaces the old `webhooks` repo** (Netlify Functions + Airtable) with a single Cloudflare Worker, using a Durable Object for the one piece of real runtime state: the co-working room. There is no separate database — Airtable is gone.

It carries over the architecture decisions worked out for the webhooks migration (Workers + Durable Objects, `slack-web-api-client`, env-based config, native cron, Web Crypto signature verification, and the richer Slack Calls + Zoom registrant flow for the co-working room).

---

## 1. Goals

- **One deployable.** All bots live in a single Worker, routed internally by path. Simple to reason about, one deploy, one set of secrets.
- **No external database.** The only stateful bot (co-working room) uses a Durable Object with SQLite-backed storage. Everything else is stateless request/response or cron.
- **Edge-native dependencies only.** No Node-only SDKs or polyfills. The Slack client is `slack-web-api-client` (fetch-based, strong types); Zoom and signature verification use `fetch` + Web Crypto.
- **Race-free co-working state.** A Durable Object keyed by the Zoom meeting ID serializes every event for that meeting, eliminating the eventual-consistency race that the old Airtable code worked around with a retry loop.
- **Easy to grow.** Adding a new bot is a new module + a route (or a new cron branch), not a new service.

---

## 2. The bots

| Bot | Trigger | What it does | State? |
| --- | --- | --- | --- |
| **Co-working room** | Zoom webhooks + Slack interactivity | Renders a live Slack Call in `#co-working-room`; mints per-user Zoom join links; keeps the call's participant list in sync as people join/leave. | **Yes** — Durable Object |
| **Welcome** | Slack `team_join` event | Posts a welcome message to new members. | No |
| **App Home** | Slack `app_home_opened` event | Publishes the bot's App Home view. | No |
| **Event reminders** | Cron (hourly / daily / weekly) | Queries the CMS for upcoming events and posts Block Kit reminders to Slack. | No |

---

## 3. High-level architecture

```
   Zoom webhooks ───────▶┐
   Slack events ────────▶│   Cloudflare Worker  (src/index.ts)
   Slack interactivity ─▶│   ├─ fetch():      verify sig → route by path → bot module
   Cron (UTC) ──────────▶│   └─ scheduled():  dispatch reminders by cron expression
                         └──────────────┬───────────────────────────────────────────┘
                                        │ env.COWORKING_ROOM.getByName(zoomMeetingId)
                                        ▼
                         ┌──────────────────────────────────────────────┐
                         │  CoworkingRoom  (Durable Object, SQLite)      │
                         │  - serializes all events for the room         │
                         │  - sessions / registrants / participants      │
                         │  - calls Slack (calls.*) + Zoom (registrants) │
                         │  - alarm() stale-session safety net           │
                         └──────────────────────────────────────────────┘

   Config: env vars (single room).  Secrets: Slack/Zoom/CMS tokens.
   Outbound: slack-web-api-client (chat.*, calls.*, views.*, users.*); Zoom REST.
```

The `fetch()` handler is the HTTP front door (webhooks, events, interactivity). The `scheduled()` handler runs the reminder cron jobs natively — no external scheduler and no public reminder endpoint to secure. Only the co-working bot needs durable state, so it's the only thing behind a Durable Object; the other three bots are plain functions.

---

## 4. Repository layout

Single flat package (no pnpm workspace). The `pnpm-workspace.yaml` currently in the repo can be removed — we're not splitting into multiple packages or Workers.

```
bots/
├─ src/
│  ├─ index.ts              # Worker entry: exports fetch() + scheduled() + the DO class
│  ├─ router.ts             # path → handler routing
│  ├─ env.ts                # Env interface
│  ├─ bots/
│  │  ├─ coworking/
│  │  │  ├─ durable-object.ts   # CoworkingRoom DO (storage + RPC + alarm)
│  │  │  ├─ zoom-events.ts      # meeting.started/ended/participant_joined/left handlers
│  │  │  ├─ slack-call.ts       # calls.add / update / end / participants.*
│  │  │  └─ join.ts             # interactivity → Zoom registrant → personal join link
│  │  ├─ welcome.ts             # team_join
│  │  ├─ app-home.ts            # app_home_opened
│  │  └─ reminders/
│  │     ├─ index.ts            # scheduled() dispatch (hourly/daily/weekly)
│  │     ├─ cms.ts              # graphql-request queries
│  │     └─ blocks.ts           # Block Kit message builders
│  ├─ slack/
│  │  ├─ client.ts              # SlackAPIClient factory from env
│  │  ├─ verify.ts              # Web Crypto Slack signature verification
│  │  └─ types.ts               # shared Slack payload narrowing
│  └─ zoom/
│     ├─ verify.ts              # Web Crypto Zoom signature + url_validation
│     └─ oauth.ts               # Server-to-Server OAuth token (cached)
├─ wrangler.jsonc
├─ .dev.vars                    # local secrets (gitignored)
├─ package.json                 # already has slack-web-api-client, luxon, slackify-html
└─ docs/design.md               # this document
```

---

## 5. Routing & entrypoint

`src/index.ts` exports the Worker handlers and the DO class. The DO class **must** be exported from the Worker's main module so the runtime can bind it.

```ts
export { CoworkingRoom } from "./bots/coworking/durable-object";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(req, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    return runReminders(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

Routes (each verifies the relevant signature *before* parsing the body):

| Method & path | Handler | Notes |
| --- | --- | --- |
| `POST /zoom/webhook` | co-working / Zoom events | Verify `x-zm-signature`; handle `endpoint.url_validation`; route to DO by meeting ID. |
| `POST /slack/events` | welcome, App Home | Verify Slack signature; handle `url_verification` challenge; dispatch by `event.type`. |
| `POST /slack/interactivity` | co-working join | Verify Slack signature; ACK within 3s; do Zoom work async. |
| `GET /room/join` | co-working join (fallback) | Optional redirect endpoint if we ever want a URL-style button. |

Signature verification is the one cross-cutting concern; it lives in `slack/verify.ts` and `zoom/verify.ts` and runs as the first step of each route.

---

## 6. Co-working room: the Durable Object

### 6.1 Keying & lifecycle

One DO instance **per Zoom meeting ID**, addressed deterministically:

```ts
const stub = env.COWORKING_ROOM.getByName(zoomMeetingId); // = get(idFromName(zoomMeetingId))
await stub.handleZoomEvent(event);
```

`idFromName` is deterministic and each DO has exactly one globally-unique, single-threaded instance, so all events for a meeting are processed in arrival order without interleaving. VC runs one room today, so in practice there's one live instance — but keying by meeting ID means a second room is a config change, not a code change.

> **Ephemeral memory:** a DO hibernates after ~10s idle and is evicted after a couple idle minutes; in-memory fields are discarded and the constructor re-runs on wake. All durable state lives in `ctx.storage`; we hydrate in the constructor via `blockConcurrencyWhile`.

### 6.2 Storage schema (SQLite-backed)

New DO namespaces use the SQLite backend (`new_sqlite_classes`) — it's GA, available on the Workers Free plan, and gives both the SQL and KV APIs on the same object.

```sql
CREATE TABLE IF NOT EXISTS session (
  instance_uuid     TEXT PRIMARY KEY,  -- Zoom meeting instance UUID (per occurrence)
  slack_call_id     TEXT,              -- Slack Call object id ("R...")
  slack_message_ts  TEXT,              -- ts of the channel message holding the call block
  zoom_meeting_id   TEXT NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,           -- null while active
  status            TEXT NOT NULL      -- 'active' | 'ended'
);

-- People we registered into Zoom (created at Slack-click time, BEFORE they join).
CREATE TABLE IF NOT EXISTS registrant (
  registrant_id   TEXT PRIMARY KEY,    -- Zoom registrant id (the correlation key)
  instance_uuid   TEXT,
  slack_user_id   TEXT,                -- "U..." known member
  email           TEXT,
  display_name    TEXT,
  created_at      INTEGER
);

-- Live participants in the current session (mirrors the Slack call participant list).
CREATE TABLE IF NOT EXISTS participant (
  zoom_user_id    TEXT,                -- ephemeral per-meeting id (for join/leave matching)
  instance_uuid   TEXT,
  registrant_id   TEXT,                -- correlation back to registrant (may be null)
  slack_user_id   TEXT,
  external_id     TEXT,                -- id passed to Slack for non-member guests
  display_name    TEXT,
  joined_at       INTEGER,
  PRIMARY KEY (zoom_user_id, instance_uuid)
);
```

### 6.3 RPC surface

- `handleJoinRequest({ slackUserId, email, displayName }) → { joinUrl }` — ensure a session exists, create a Zoom registrant, return the per-user join URL.
- `handleZoomEvent(event)` — dispatch on `meeting.started | ended | participant_joined | participant_left`.
- `alarm()` — stale-session safety net (§9).

---

## 7. Co-working end-to-end flow

### 7.1 Starting / joining

The Join button is **interactive** (an `action_id`, no static `url`) so the click tells us *who* clicked and lets us mint a per-user Zoom link.

```
User clicks "Join the co-working room" (interactive button)
   └─▶ POST /slack/interactivity   (slack_user_id, trigger_id, channel)
         Worker verifies signature, ACKs within 3s
         └─▶ DO.handleJoinRequest({ slackUserId })
               1. users.profile.get → member email (scope users:read.email)
               2. active session?  no → start/record session
               3. POST /meetings/{id}/registrants (email, first_name,
                  custom field = slack_user_id) → unique join_url + registrant_id
               4. store registrant row (registrant_id ↔ slack_user_id)
         └─▶ follow-up ephemeral message (via response_url) with the personal Zoom link
```

Registering the member up front is what makes later correlation reliable — we hold `registrant_id ↔ slack_user_id` before anyone joins. Zoom registration must be enabled with `approval_type: 0` (auto-approve) for the registrant endpoint to mint usable join URLs.

### 7.2 Meeting starts

```
Zoom meeting.started ─▶ DO.handleZoomEvent
   - write session row (instance_uuid, status='active', started_at)
   - calls.add { external_unique_id: instance_uuid, join_url, title, created_by: bot, date_start }
     → Slack returns call id "R..."
   - chat.postMessage to #co-working-room with a `call` block { type:"call", call_id }
   - store slack_call_id + slack_message_ts on the session row
```

### 7.3 Participant joins / leaves

```
participant_joined ─▶ correlate registrant_id (primary) → participant_user_id → email → name
   - known member:  calls.participants.add { users:[{ slack_id }] }
   - guest:         calls.participants.add { users:[{ external_id, display_name }] }
   - upsert participant row

participant_left ─▶ look up participant by zoom_user_id
   - calls.participants.remove { users:[{ slack_id | external_id }] }
   - delete participant row
```

**Correlation:** Zoom's participant webhook carries a dedicated `registrant_id` field equal to the `id` returned by *Add a registrant*. Use it as the primary key, with `participant_user_id` → `email` → display-name fallbacks (`registrant_id` can be blank for guests who join without logging in; `user_id`/`participant_uuid` are ephemeral per-meeting and unsafe for identity).

### 7.4 Meeting ends

```
meeting.ended ─▶ DO.handleZoomEvent
   - calls.end { id: slack_call_id, duration }
   - chat.update the message to a "session ended — start a new one" state
   - mark session ended_at + status='ended'; clear participant rows; deleteAlarm()
```

---

## 8. The simpler bots

### 8.1 Welcome (`team_join`)

`POST /slack/events` → after signature + `url_verification` handling, dispatch on `event.type === "team_join"` → `slack.chat.postMessage(...)` with the welcome Block Kit. Stateless.

### 8.2 App Home (`app_home_opened`)

Same route, `event.type === "app_home_opened"` → `slack.views.publish({ user_id, view })`. Stateless.

### 8.3 Event reminders (cron)

The `scheduled()` handler branches on the matched cron expression:

```ts
async function runReminders(controller: ScheduledController, env: Env) {
  switch (controller.cron) {
    case "0 * * * *":    return hourly(env);
    case "0 13 * * *":   return daily(env);    // UTC — translate from intended local time
    case "0 13 * * MON": return weekly(env);
  }
}
```

Each branch queries the CMS via `graphql-request`, filters upcoming events with `luxon`, formats Block Kit (`slackify-html` for any HTML body), and posts to Slack. Cron triggers run in **UTC**, so the intended local send-times must be translated (and a fixed UTC time shifts ±1h across DST — see open questions). There's a small per-Worker cron limit (commonly 3), which is exactly what we use.

---

## 9. Integrations, auth & reliability

### 9.1 Slack

`slack-web-api-client` (`new SlackAPIClient(env.SLACK_BOT_TOKEN)`) for all outbound calls — `chat.*`, `calls.*`, `views.*`, `users.*` — with typed requests/responses and Block Kit types. Inbound verification uses Web Crypto, not Bolt.

**Scopes:** `chat:write`, `calls:read`, `calls:write`, `users:read.email`, `views:publish` (App Home), plus the event subscriptions `team_join`, `app_home_opened`.

### 9.2 Zoom

Webhook events (`meeting.started/ended/participant_joined/left`) verified via `x-zm-signature` (Web Crypto HMAC), with the `endpoint.url_validation` challenge answered by `hmacSha256Hex(secret, plainToken)`. The registrant API is called with a **Server-to-Server OAuth** token: `POST https://zoom.us/oauth/token?grant_type=account_credentials&account_id=…` with `Authorization: Basic base64(client_id:client_secret)`. Tokens last ~1h with no refresh token, so the DO caches the token in storage and re-fetches on expiry. Zoom scopes: `meeting:read`/`meeting:write`.

### 9.3 Signature verification (Web Crypto)

```ts
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
```

Slack message = `v0:${timestamp}:${rawBody}` (reject if `|now - ts| > 300s`); Zoom message = `v0:${zmTimestamp}:${rawBody}`. Read the raw body once with `await req.text()` and verify before parsing; compare fixed-length / constant-time.

### 9.4 Reliability

- **No retry loop.** `meeting.started` and `participant_joined` are serialized through one DO with synchronous storage, so the session row is written before the join is processed. The old Airtable polling loop is gone.
- **Fast ACK.** Verify → hand to DO → return `200` promptly. For interactivity, ACK immediately and do the Zoom registrant call async (follow up via `response_url`) so a slow Zoom call never trips Slack's 3s timeout.
- **Idempotency.** Zoom can deliver duplicates; participant rows key on `(zoom_user_id, instance_uuid)` and upsert; `calls.end` on an ended call returns `inactive_call`, treated as success.
- **Stale-session alarm.** On `meeting.started`, `setAlarm()` a few hours out; `alarm()` force-ends a still-active session if a `meeting.ended` was ever missed. Alarms are at-least-once with automatic retry.

---

## 10. Configuration & secrets

Single room ⇒ config in Worker **vars**; credentials in **secrets**.

```jsonc
// wrangler.jsonc
{
  "name": "vc-bots",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "durable_objects": {
    "bindings": [{ "name": "COWORKING_ROOM", "class_name": "CoworkingRoom" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CoworkingRoom"] }
  ],
  "triggers": { "crons": ["0 * * * *", "0 13 * * *", "0 13 * * MON"] },
  "vars": {
    "ZOOM_MEETING_ID": "000000000",
    "SLACK_COWORKING_CHANNEL_ID": "C0000000000",
    "ZOOM_MEETING_INVITE_URL": "https://us.zoom.us/j/000000000",
    "ROOM_TITLE": "Co-Working Room"
    // ...remaining message/notice strings from the old rooms config
  }
}
```

Secrets (`wrangler secret put …`, never `vars`):

```
SLACK_BOT_TOKEN  SLACK_SIGNING_SECRET
ZOOM_WEBHOOK_SECRET_TOKEN
ZOOM_S2S_CLIENT_ID  ZOOM_S2S_CLIENT_SECRET  ZOOM_S2S_ACCOUNT_ID
CMS_TOKEN
```

```ts
export interface Env {
  COWORKING_ROOM: DurableObjectNamespace<CoworkingRoom>;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ZOOM_WEBHOOK_SECRET_TOKEN: string;
  ZOOM_S2S_CLIENT_ID: string;
  ZOOM_S2S_CLIENT_SECRET: string;
  ZOOM_S2S_ACCOUNT_ID: string;
  CMS_TOKEN: string;
  ZOOM_MEETING_ID: string;
  SLACK_COWORKING_CHANNEL_ID: string;
  // ...vars
}
```

Local dev uses `.dev.vars` (gitignored). `wrangler types` can generate the `Env` type from the config.

---

## 11. Dependencies

Already in `package.json`: `slack-web-api-client`, `luxon`, `slackify-html`. The plan builds on these.

**Add:**

| Package | Purpose |
| --- | --- |
| `hono` *(optional)* | HTTP router for the Worker's routes + verification middleware. `itty-router` is a lighter alternative; plain `switch` is also fine. |
| `graphql-request` | CMS queries for event reminders (fetch-based, Workers-native). |
| `wrangler` *(dev)* | Local dev, deploy, `wrangler types`. |
| `vitest` + `@cloudflare/vitest-pool-workers` *(dev)* | Test the DO and Web Crypto inside the real `workerd` runtime. |
| `@slack/types` *(dev, optional)* | Block Kit typings, only if not covered by `slack-web-api-client`. |

**Do not add:** `@slack/web-api` (Node-only — axios + node built-ins; maintainers won't support edge runtimes), `@slack/bolt` (Node-oriented receiver machinery; we only handle a few events and verify manually), `@slack/oauth` (multi-workspace install flow — not needed for a single-workspace bot token), `airtable`, anything Netlify.

> The `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` for `@slack/bolt` can be dropped along with the workspace file, since we're not using Bolt or a workspace.

---

## 12. Build plan (phased)

1. **Scaffold.** `wrangler.jsonc`, `src/index.ts`, `Env` type, `.dev.vars`, router. Deploy a `200`-returning Worker to `*.workers.dev`.
2. **Shared primitives.** `slack/verify.ts`, `zoom/verify.ts` (Web Crypto) and `slack/client.ts`, with unit tests (sign↔verify round-trips, Zoom URL-validation vector).
3. **Simple bots first.** Welcome + App Home + event reminders (cron). These are low-risk and prove routing, signatures, Slack outbound, and `scheduled()`.
4. **Co-working DO at parity.** `CoworkingRoom` with the §6.2 schema and the four Zoom handlers, posting/updating a plain message + threaded join/left — proving the DO, routing, and race-free behavior before the Calls API.
5. **Layer in Slack Calls + Zoom registrants.** Interactivity Join button, S2S OAuth token caching, `calls.*`, participant correlation.
6. **Cutover.** Point Zoom + Slack app URLs at the Worker, set cron triggers, run alongside the old Netlify stack briefly, then retire `webhooks` + Airtable.

Steps 1–4 are independently shippable.

---

## 13. Open questions

1. **Who can start a session?** Should the bot *programmatically start* the Zoom meeting on first Slack click (needs extra Zoom scopes), or keep the meeting always-joinable and treat the first registrant click as "start"?
2. **Email mapping.** OK to use the `users:read.email` scope for clean Slack-member → Zoom-registrant correlation, or avoid it and match on display name (less reliable)?
3. **Guests without Slack accounts.** Confirm we're happy showing them in the call widget as `external_id` guests with no profile link.
4. **Reminder schedule in UTC.** Need the exact intended local send-times for hourly/daily/weekly to translate into UTC cron expressions, and a decision on DST handling (Workers cron is fixed UTC).
5. **Plan & limits.** Free plan (SQLite DOs included) vs an existing paid Workers account?
6. **Repo hygiene.** Remove `pnpm-workspace.yaml` and add `.dev.vars`/`.wrangler` to `.gitignore` as part of scaffolding — confirm.

---

## Sources

- Cloudflare — [What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [DO storage / SQLite](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/), [Namespace API](https://developers.cloudflare.com/durable-objects/api/namespace/), [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [DO free tier](https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/)
- Slack — [Using the Calls API](https://docs.slack.dev/apis/web-api/using-the-calls-api), [`calls.add`](https://docs.slack.dev/reference/methods/calls.add), [`calls.end`](https://docs.slack.dev/reference/methods/calls.end), [`calls.participants.add`](https://docs.slack.dev/reference/methods/calls.participants.add), [`slack-web-api-client`](https://github.com/seratch/slack-web-api-client), [node-slack-sdk #1335 (web-api is Node-only)](https://github.com/slackapi/node-slack-sdk/issues/1335)
- Zoom — [Meetings API](https://developers.zoom.us/docs/api/meetings/), [Webhook events](https://developers.zoom.us/docs/api/meetings/events/), [Server-to-Server OAuth](https://developers.zoom.us/docs/internal-apps/s2s-oauth/)
