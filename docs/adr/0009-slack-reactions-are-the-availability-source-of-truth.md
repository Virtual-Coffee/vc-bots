# 0009 — Availability sign-ups live in Slack's reactions; the DO stores only message pointers

**Status:** Accepted (2026-09-18)

## Context

The weekly availability check-in (issue #19) replaces three Slackbot `/remind`s: an intro
with a role legend, then a "Tuesday" and a "Thursday" message people react on with role emoji.
The pain was that reading who signed up for what meant hovering every reaction. The bot now
edits each day message so every role line lists its sign-ups.

Reaction events are the only signal Slack gives us, and they are not reliable enough to be a
ledger: an event can be dropped, delivered twice, or arrive out of order, and two people
reacting at once produce two events that race through the Worker. The obvious design — a
Durable Object that keeps the sign-up lists and applies each `reaction_added` /
`reaction_removed` as a delta — turns every one of those into a permanently wrong message.

## Decision

- **Slack's reaction list is the source of truth.** A refresh re-reads `reactions.get` for
  the day message and re-renders the whole sign-up sheet from it. The DO never stores a
  sign-up.
- **`AvailabilitySheet` stores only pointers**: the two day-message `ts` (with the post time,
  so re-renders keep their dates) and the cached bot user id. No SQL tables.
- **Refreshes coalesce per message.** DO input gates don't serialize across a Slack `fetch`,
  so an in-memory map marks a message dirty while a render is in flight and runs exactly one
  more render after it. Any burst of events collapses to at most two renders, and the last
  one reflects Slack's current state.
- **The bot seeds the five reactions** on each day message so people one-click; its own user
  id is filtered out of the sheet, and its own events (`ignoreSelfEvents: false`, ADR 0007)
  are dropped by reactor id before any Slack call.
- **Every post is fresh.** Re-running the post (cron double-fire, an admin run) posts a new
  trio and repoints; the old messages simply stop updating. No week bookkeeping.

Alternatives rejected: a DO-held ledger of sign-ups (drifts on any lost or duplicated event,
with no way to notice); day messages as thread replies (Slack doesn't notify the channel for
replies, and the reactions would be buried); a per-reactor `users.info` render with plain
names (no notifications, but N extra calls per refresh and names that go stale).

## Consequences

- A dropped or duplicated reaction event self-heals on the next one; a message that never gets
  another reaction can be at most one event stale.
- Editing a mention into the message notifies that person once — accepted as a confirmation.
- The bot needs `reactions:read` + `reactions:write` and the `reaction_added` /
  `reaction_removed` event subscriptions; it must be a member of the availability channel.
- A hand-deleted day message is logged (`availability.message_vanished`) and skipped; the next
  Monday post replaces it.
