# 0010 — One `AdminAction` union behind `runAdminAction`; the slash command and the panel are adapters

**Status:** Accepted (2026-09-17)

## Context

Workspace admins can make the bots do five things by hand: run a reminder, send a welcome,
publish an App Home, announce the co-working room, and manage the calendar watch. Two Slack
surfaces request them — `/vc-bot-admin` with arguments, and the button panel the bare command
opens (buttons and modals). Before this decision each surface carried its own copy of the
workspace-admin gate, its own try/catch and its own reply text, and the two drifted: an
operation added to the slash command was missing from the panel, and the panel's error copy
differed from the slash's for the same failure.

## Decision

- **One `AdminAction` union (`src/bots/admin/actions.ts`)** is the whole vocabulary:
  `reminder` (`daily|weekly`, optional source name), `welcome` (a target user), `home`,
  `coworking` (`open|close`), `watch` (`status|start|stop`).
- **`runAdminAction(env, userId, action)`** is the single entry: it applies the
  workspace-admin gate (`isWorkspaceAdmin`, with a temporary allowlist), runs the operation
  inside the one try/catch, and returns an `AdminResult` — `denied`, `failed`, or the
  operation's outcome. `adminReplyText(result)` turns any result into the reply line, so the
  two surfaces say the same thing for the same outcome.
- **`slash.ts` and `panel.ts` are adapters.** Each parses its payload into an `AdminAction`,
  runs it, and delivers the result through `src/slack/response.ts` (ADR 0004). Neither gates
  or catches on its own. The only direct `guardAdmin` calls are for work that runs no action:
  the slash usage / panel replies, and the panel buttons that open a modal.
- **The slash grammar**: `daily|weekly [source]`, `welcome [@user]`, `home`,
  `coworking open|close`, `watch status|start|stop`; no arguments opens the panel.
- **Modals.** Panel buttons open modals via `client.views.open({ trigger_id, view })`;
  submits arrive through `.viewSubmission(callbackId, ack, lazy)` in `src/slack/app.ts`,
  acked with the empty view ack (ADR 0004). The panel's `response_url` travels into the modal
  as `private_metadata` (`JSON.stringify({ response_url })`) and back out on submit, and the
  handler then `replaceEphemeral`s the panel with output (reminder counts) or
  `deleteOriginal`s it when the result is self-verifiable in a channel, Home or DM.

## Consequences

- A new admin operation is: a variant on `AdminAction` and `AdminResult`, a case in
  `runAdminAction`, a line in `adminReplyText`, then the slash parse and the panel button /
  modal. The gate and the error path come for free.
- An adapter that catches or gates on its own is a regression: a result the other surface
  cannot produce.
- Everything the panel shows a user is an ephemeral reply, so it is safe to replace or delete
  (ADR 0004); a modal cannot be closed from a later button click, which is why the panel,
  not a modal, is the surface that lingers.
