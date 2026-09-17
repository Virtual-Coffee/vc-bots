# 0003 — Zoom events are serialized inside the co-working DO, not by the runtime

**Status:** Accepted (2026-09-17)

## Context

`CoworkingRoom` is one Durable Object instance per Zoom meeting ID, and the design assumed that
routing every webhook for a meeting through that single instance made the handlers race-free.
It does not. A Durable Object's input gate closes only while a **storage** operation is in
flight; during an outbound `fetch` (every Slack call the room makes) the runtime keeps
delivering other requests to the same object. `onMeetingStarted` awaited the open card's
`chat.postMessage` *before* inserting the session row, so a `participant_joined` arriving in
that window found no active session and was dropped. Production logs from 2026-09-17 show
exactly that: `meeting.started` at 13:29:34.402, the host's `participant_joined` 41 ms later,
its request finishing at .524, and `coworking.started` (the row insert) only at .683. The host
was missing from the presence list until they left and re-joined. The drop logged at `debug`,
invisible at the `info` level prod runs at.

`closeSession` had the same shape — `await roomMessage.close(...)` and then delete the
participant rows — so a join landing mid-close could insert a row and re-render the ended card
as a presence card.

## Decision

- **The DO serializes its own state-mutating work.** `CoworkingRoom.enqueue` chains work onto
  an in-memory promise queue; `handleZoomEvent`, `alarm`, `adminAnnounceOpen` and
  `adminAnnounceClose` all run through it, so each completes — Slack calls included — before the
  next starts. The queue tail never rejects, so one failing handler can't wedge the room; the
  failing caller still sees its own error.
- **Join-token RPCs stay outside the queue.** `handleJoinRequest` / `resolveJoinToken` touch
  only `member_link` / `invite_link` and sit on the Slack button's 3 s window; they must not
  wait behind a queued Slack post.
- **The router ACKs Zoom immediately.** `POST /zoom/webhook` returns `200` and dispatches to
  the DO in `ctx.waitUntil`. Awaiting the RPC never provided ordering (two Worker requests are
  independent) and, with a queue, would only risk Zoom's ~3 s timeout and a retry storm.
- **A dropped join logs at `warn`.** `coworking.joined.drop_no_session` is data loss, not
  chatter.
- **The queue logs when it actually queues.** `coworking.queue.wait` (`info`, with the work's
  label and depth) fires only when an item lands behind in-flight work — the interleaving this
  ADR exists for. Per-item `coworking.queue.run` / `.done` (wait and run ms) are `debug`.

## Consequences

- Events queue behind each other's Slack calls (~300 ms each). At this room's volume — a
  handful of events per session — that is invisible.
- `blockConcurrencyWhile` was rejected: it would also block the join-token RPCs and the alarm,
  and Cloudflare documents holding it across `fetch` as an anti-pattern.
- The queue is in-memory. If the isolate is evicted mid-queue, the pending RPCs die with it.
  Zoom has already been ACKed, so those events are lost — no worse than before, when the
  in-flight handler died the same way.
- Zoom delivering `participant_joined` *before* `meeting.started` is still unhandled (the
  join is dropped with a warn). It was not observed in the logs; if it turns up, the fix is to
  buffer joins for an unknown instance and replay them on `meeting.started`.
- Tests in `test/coworking-do.test.ts` ("event serialization") reproduce both windows by
  parking the DO inside a stubbed `fetch` and delivering a second event before releasing it.
