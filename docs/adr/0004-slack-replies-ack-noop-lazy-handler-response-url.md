# 0004 — Slack replies: ack with a no-op, work in the lazy handler, reply through our `response_url` helpers

**Status:** Accepted (2026-09-17)

## Context

Slack gives an interaction, event or slash command ~3 s to get a `200`; anything slower is
retried or shown to the user as a failure. Every handler here does at least one Slack API call
(hundreds of ms each), and the join flow also mints a Zoom invite link, so the real work cannot
sit inside that window.

`slack-cloudflare-workers` splits every registration into an **ack** (runs before the HTTP
response) and a **lazy handler** (runs in `ctx.waitUntil` after it). It also offers
`context.respond`, a thin wrapper that POSTs whatever params it is given to the payload's
`response_url`. Two of our buttons live on a *shared* channel message (the room card's Join
button, the reminders' Join Event button): their `response_url`'s "original" is that shared
message, and a reply that omits `response_type: "ephemeral"` or carries `replace_original:
true` / `delete_original: true` rewrites or deletes it for the whole channel.

## Decision

- **Every ack is a no-op.** Actions and commands ack with the shared `ack` const (`async () =>
  {}`); view submissions ack with a literal empty `async () => {}` (returning void is what
  closes the modal, and the shared const's `AckResponse` type does not satisfy the view ack).
  The HTTP response never carries a user-facing reply.
- **All work runs in the lazy handler**, and its reply goes to the payload's `response_url`
  through `src/slack/response.ts` only:
  - `respondEphemeral` — pins `response_type: "ephemeral"` and `replace_original: false`. Safe
    against any `response_url`, including the shared room message's.
  - `replaceEphemeral` (`replace_original: true`) and `deleteOriginal` (`delete_original:
    true`) — pin `ephemeral` too, but they act on the "original", so they are used **only**
    against per-user ephemerals (the admin panel, the join ephemeral). Never against a channel
    button's `response_url`.
- **`context.respond` is rejected.** It posts params verbatim: no ephemeral default, no
  `replace_original` pin, so the guardrail would live in every call site instead of one file.
- A modal has no `response_url`; the panel's travels into the modal as `private_metadata` and
  back out on submit, so the view's lazy handler can reach the panel ephemeral the same way.

## Consequences

- Handlers are fire-and-forget: a failed `response_url` POST is logged
  (`slack.response_url.*`), never thrown — an unhandled rejection inside `waitUntil` is
  invisible.
- A handler that needs a Slack reply but has no `response_url` (events like `team_join`) posts
  through the client instead; the helpers are for interactions and commands only.
- Adding a new button on a shared message means: register it with `ack`, reply with
  `respondEphemeral`, and nothing else. Adding one on a per-user ephemeral may use all three.
