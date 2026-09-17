# 0007 — Static Slack `authorize`; the self-event filter is disabled, not relied on

**Status:** Accepted (2026-09-17)

## Context

`slack-cloudflare-workers` resolves the bot token per request through an `authorize`
function. Its default, `singleTeamAuthorize`, calls `auth.test` on every request to learn the
bot's `botId` / `botUserId` — on the ack path, inside the 3 s window (ADR 0004), for a token
that never changes. Those ids feed one thing: the `ignoringSelfEvents` middleware, which drops
events whose `bot_id` / `user` matches the bot so it doesn't react to its own messages.

This is a single-workspace app with one fixed `SLACK_BOT_TOKEN`, and the only events it
subscribes to are `team_join` and `app_home_opened` — neither is something the bot can
trigger on itself.

## Decision

- **`authorize` is static**: it returns `env.SLACK_BOT_TOKEN` with empty `botId`, `botUserId`
  and `botScopes`. No network call per request.
- **`ignoreSelfEvents: false`, explicitly.** With empty ids the filter has nothing to match, so
  it would be a no-op today — but relying on that leaves the behaviour to the framework's
  matching rules. An event without a `bot_id` (`team_join`, `app_home_opened`) risks being
  swallowed if those rules treat an empty id as a match, so the filter is switched off rather
  than left to fall through.
- `singleTeamAuthorize` is rejected for the per-request `auth.test`.

## Consequences

- The ack path does no Slack I/O; `createSlackApp` is closures-only and safe to build per
  request.
- If the app ever subscribes to `message` events, it will see its own posts. That change must
  either supply real `botId` / `botUserId` (cached from one `auth.test`, not per request) and
  re-enable the filter, or filter in the handler.
- A second workspace means a real `authorize`; nothing else assumes a single team.
