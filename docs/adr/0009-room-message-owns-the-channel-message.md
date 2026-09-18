# 0009 — `RoomMessage` owns the channel message; the DO owns the session and the join tokens

**Status:** Accepted (2026-09-17)

## Context

The co-working room is one Zoom meeting mirrored into one Slack channel. Its state (is a
session open, who is in it, which invite links are live) belongs in the `CoworkingRoom`
Durable Object, one instance per meeting id (`env.COWORKING_ROOM.getByName(meetingId)`,
serialized per ADR 0003). Its *presence in Slack* is a single self-managed **room message**
per session — no native Slack Call widget — whose Block Kit cards, copy and cross-session
pointers changed on almost every feature commit while the session state machine did not.

Keeping both in the DO class meant every card tweak touched the state machine's file and
the DO test suite, and the DO suite could not run without a Slack stub. The two also fail
differently: a Slack edit that fails should never wedge a session.

## Decision

- **The DO owns the session state machine and the join tokens** (`session` / `participant` /
  `member_link` / `invite_link`, created idempotently in `migrate()` under
  `blockConcurrencyWhile`), a stale-session `alarm()` that force-closes sessions that never
  received `meeting.ended`, and nothing about the channel message — it never sees a message
  `ts`.
- **`RoomMessage` (`src/bots/coworking/room-message.ts`) owns everything about the channel
  message**: the cards, the copy, the cross-session pointers. The DO calls `open` /
  `showPresence` / `close` / `announceOpen` / `announceClose`. Block Kit layouts are private
  to the module and hand-tuned: keep them byte-for-byte when moving code, and put layout and
  pointer assertions in `test/room-message.test.ts` against
  `test/helpers/room-channel-fake.ts`, not in the DO suite.
- **Two swappable ports** are the DO's only outward edges, installed as private fields so the
  DO suite never touches `fetch` (`test/helpers/invite-link-fake.ts` and
  `installRoomChannelFake` on every `runInDurableObject` entry; wire tests for the adapters
  live in `test/zoom-invite-links.test.ts`):
  - `InviteLinkPort` (`createZoomInviteLinkPort`, `src/zoom/invite-links.ts`): S2S token +
    `createInviteLink`.
  - `RoomChannelPort` (`createSlackRoomChannelPort`): post / update / delete on the co-working
    channel. It classifies `message_not_found` / `channel_not_found` as `"vanished"`, so a
    hand-deleted card never wedges the room.
- **Lifecycle.** `meeting.started` → `open` **always posts** a fresh open card (an edit would
  not notify the channel). `participant_joined/left` → `showPresence` edits the presence list.
  `meeting.ended` → `close` edits it into the ended card, which carries the **standing
  invite** and becomes the *last closed card*. Announcements (`/vc-bot-admin coworking
  open|close`) join the same chain: `announceClose` renders a full ended card (peak 0, no
  roster) with the invite, and it becomes the last closed card.
- **Retire.** The next room message (`open` for a session, `announceOpen` for an
  announcement) retires the previous card itself, right after posting: it re-renders the
  last closed card with `{ invite: false }`, closes any lingering open announcement (without
  invite), and runs the one-shot legacy `idle_invite_ts` delete — so exactly one standing
  invite exists at a time. Retiring is best-effort: each step is try/caught on its own,
  warns `coworking.room_msg.retire_failed`, and keeps its pointer for the next takeover to
  retry (the legacy delete stays one-shot). It never blocks the session.
- **Pointers live in DO storage, written and read only by `RoomMessage`**:
  `room_message:open` (the live card, `{ ts, startedAtMs }` — `open` writes it,
  `showPresence` / `close` read it), `last_closed_message` (the cached `SessionStats`:
  `participant` rows are deleted at close, so the roster cannot be re-derived from SQL) and
  `room_message:announcement`.
- **Joining is per user.** The card's Join button mints a personal Zoom **invite link**
  (name pre-filled; no registration, so the meeting must not require it) and replies via
  `response_url` with an ephemeral carrying ☕ Join / Cancel
  (`buildJoinEphemeralAttachments`, `src/bots/coworking/join.ts`). Either button deletes the
  ephemeral (`delete_original`) — a modal cannot dismiss itself from a button click. The
  ☕ Join url is the Worker's own `GET /join/<token>` redirect, built on `PUBLIC_BASE_URL`
  (the virtualcoffee.io/bots Netlify rewrite; empty falls back to the request origin).
  Tokens live in the DO's `invite_link` table and expire with the Zoom link, keeping the
  token-bearing Zoom url out of the Slack UI. The join-token RPCs touch only `member_link` /
  `invite_link` and stay outside the DO queue so the button is never slowed (ADR 0003).
- **Correlation is best-effort by display name** through `member_link` (the webhook carries
  no registrant id for invite-link joiners), only within the invite TTL. A member whose Slack
  profile name could not be read never correlates; uncorrelated people show as guests.

## Consequences

- The channel button's `response_url` has the shared room message as its "original":
  reply to it with `respondEphemeral` only (ADR 0004). `replaceEphemeral` / `deleteOriginal`
  are for the join ephemeral.
- A card change is a `room-message.ts` edit plus a `room-message.test.ts` assertion; the DO
  and its suite are untouched.
- A failed Slack edit surfaces as a `coworking.room_msg.*` warning and a stale pointer the
  next takeover retries; it never changes session state.
- Personal `join_url`s and the redirect tokens that resolve to them carry a join credential
  and never appear in log or alert fields.
