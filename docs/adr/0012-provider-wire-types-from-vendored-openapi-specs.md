# 0012 — Provider wire types are generated from vendored OpenAPI specs; adapters call through `openapi-fetch`

**Status:** Accepted (2026-09-17)

## Context

The Worker calls two provider REST APIs itself — Google (the OAuth token exchange and four
Calendar v3 operations) and Zoom (the S2S token and `invite_links`); Slack goes through
`slack-cloudflare-workers`. Each call site had its own hand-written interface for the response
(`GoogleCalendarEvent`, `InviteLinksResponse`, `ZoomTokenResponse`, inline `res.json<…>()`
generics) that nothing checked against the vendor, and its own way of building the URL,
headers and error message. A renamed field or a mistyped query parameter compiled fine.

The obvious fix has traps on workerd. `googleapis` / `@googleapis/calendar` pull in
`google-auth-library` and Node internals (ADR 0008 bans `node:*` in `src/`). openapi-typescript
reads OpenAPI 3.x only, not Google's discovery document. Zoom's Meetings document is 1.2 MB for
131 operations, of which we call one. Neither vendor publishes an OpenAPI document for its
OAuth token endpoint.

## Decision

- **Wire types are generated, never written.** `pnpm gen:api-types` (`scripts/gen-api-types.ts`)
  runs `openapi-typescript` over the documents in `specs/` and writes `src/generated/*.d.ts`
  (committed, `linguist-generated`, ignored by Prettier and ESLint). `defaultNonNullable` is
  off so a vendor default (`Event.anyoneCanAddSelf`, Zoom `ttl`) does not become a required
  field. The Google types come from APIs.guru's OpenAPI 3 conversion of the discovery document;
  Zoom's from its API Hub. Both are vendored whole by `pnpm specs:update`
  (`scripts/update-specs.ts`) so a refresh is a reviewable diff and generation is offline.
- **A vendored document is pruned to the operations we call, by Redocly, at generation
  time.** Each target lists vendor `operationId`s (`calendar.events.list`,
  `meetingInviteLinksCreate`, …); `@redocly/openapi-core`'s `filter-in` decorator drops the rest
  and `removeUnusedComponents` drops what they alone referenced. A three-line sweep removes the
  path items Google's path-level `parameters` keep alive. Calling a new endpoint means adding
  its `operationId` and regenerating. `@redocly/cli` and a `redocly.yaml` were considered:
  neither can pass `removeUnusedComponents` or express the sweep, and the CLI is a large
  dependency. `@redocly/openapi-core` is pinned to the range openapi-typescript itself declares
  (1.x at the time of writing; 2.x changes the `config.styleguide` surface) so one copy serves
  both and the bump happens together.
- **The two OAuth token endpoints have hand-written OpenAPI fragments** in `specs/`
  (`google-oauth-token`, `zoom-oauth-token`), mirroring the vendor docs for the one grant each
  Worker uses. They go through the same generator (openapi-typescript lints them through
  Redocly's built-in `minimal` config) and are marked `-linguist-vendored`.
- **One client factory, one error.** `createApiClient<paths>(…)` (`src/http/client.ts`) wraps
  `openapi-fetch` (fetch-only, runs on workerd) with the provider base URL and an optional
  bearer resolver so the caller keeps owning token caching (Google per adapter instance, ADR
  0011; Zoom in DO storage). It looks `globalThis.fetch` up per call because openapi-fetch
  captures it at creation — a module-level client would otherwise bypass a `fetch` the tests
  stub later. Non-2xx answers become `ApiError` (`src/http/error.ts`: `provider`, `status`,
  `body`) via `apiError(provider, prefix, …)`, whose `message` keeps the historical
  `"<what failed>: <status> <body>"` shape.
- **Compile-time only.** No runtime schema validation: the tolerant parsing ADR 0001/0002
  require (unknown keys ignored, an empty list page is `[]`, an unparseable start is
  `skipped`) stays, as do the adapters' small `typeof` guards and their "unexpected body shape"
  errors. `GoogleCalendarEvent` is `components["schemas"]["Event"] & { id: string }`: the spec
  makes `id` optional, Google always sends it, and a body without one is malformed.
- **What stays raw.** `src/slack/response.ts` posts to a `response_url` and never reads the
  body; `scripts/fix-calendar.ts` is a one-off Node CLI outside the Worker.

## Consequences

- A vendor field rename or a wrong parameter is a type error at the call site; paths, path and
  query params and request bodies are checked, not just responses.
- A spec refresh (`pnpm specs:update`) diffs `specs/` and `src/generated/` together; the
  generated diff is the review surface. `pnpm gen:api-types` is idempotent, so CI can enforce
  it is up to date.
- A plain-text provider error body appears in `ApiError.message` verbatim; a JSON body is
  re-stringified compactly. Callers that need the status use `instanceof ApiError`.
- `error` from openapi-fetch is `unknown` at the call sites (the vendor specs declare few or no
  error schemas); adapters branch on `response.ok` / `response.status`, never on `error`.
- `scripts/**` may import `node:*` (ESLint override); the Worker restriction is unchanged.
- openapi-typescript declares a `typescript ^5` peer; the repo's TS 6 alias works but pnpm warns.
