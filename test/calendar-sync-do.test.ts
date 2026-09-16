import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSync } from "../src/bots/calendar-sync/durable-object";
import type { JoinInfo, ReminderEvent } from "../src/events";
import { createCalendarFake, type FakeCalendar, installCalendarFake } from "./helpers/calendar-fake";
import { type FetchRecorder, installFetchRecorder } from "./helpers/fetch-recorder";

/**
 * Unit-tests the CalendarSync DO directly via `runInDurableObject` (no RPC): we get the live
 * instance and call its methods. The Google side is the in-memory `CalendarPort` fake, swapped
 * into the instance with `installCalendarFake` on every entry (a DO may be re-instantiated
 * between calls, so the swap is repeated rather than done once); the Slack side stays on the
 * fetch recorder so posts/schedules are counted as real Web API calls.
 *
 * The DO reads its own `this.env` (the namespace binding), NOT a per-test override — so the
 * watch token and calendar id come from the pinned miniflare bindings in `vitest.config.ts`.
 */

// A fixed "now" for the diff tests: Wednesday 2026-06-17, 12:00 EDT. Its ISO week runs Monday
// 2026-06-15 → Monday 2026-06-22, so `at(+48h)`/`at(+72h)` land on Fri/Sat (in-window, future),
// `at(-24h)` is Tuesday (in-window, past), and `at(+6d)` is next Tuesday (out of window).
const NOW = Date.parse("2026-06-17T16:00:00Z");
const NOW_DT = DateTime.fromMillis(NOW, { zone: "America/New_York" });

let rec: FetchRecorder;
let fake: FakeCalendar;
/** Slack channel ids whose chat.postMessage answers `ok: false` (simulated delivery failure). */
let failPostsTo: Set<string>;

beforeEach(() => {
  fake = createCalendarFake();
  failPostsTo = new Set();
  rec = installFetchRecorder({
    respond(call) {
      if (call.url.includes("/api/chat.scheduledMessages.list")) {
        return Response.json({ ok: true, scheduled_messages: [] });
      }
      if (call.url.includes("/api/chat.postMessage")) {
        const channel = new URLSearchParams(call.body).get("channel") ?? "";
        if (failPostsTo.has(channel)) return Response.json({ ok: false, error: "channel_not_found" });
      }
      return undefined;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Address a fresh DO instance per test (unique name → isolated SQLite, no snapshot leakage). */
function syncStub(name = `cs-${crypto.randomUUID()}`) {
  const ns = env.CALENDAR_SYNC;
  const id = ns.idFromName(name);
  return ns.get(id);
}

/**
 * Run a callback against the live CalendarSync instance with the calendar fake installed. The
 * test-env binding type isn't narrowed to `CalendarSync`, so we cast the instance for the
 * callback — `runInDurableObject` hands back the real object either way.
 */
function withSync<T>(
  stub: ReturnType<typeof syncStub>,
  fn: (instance: CalendarSync, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, (instance, state) => {
    const sync = instance as unknown as CalendarSync;
    installCalendarFake(sync, fake);
    return fn(sync, state);
  });
}

function slackPosts() {
  return rec.callsTo("/api/chat.postMessage");
}
function postedText(): string {
  return slackPosts()
    .map((p) => rec.form(p).get("text") ?? "")
    .join("\n");
}
function channelRows(stub: ReturnType<typeof syncStub>) {
  return withSync(stub, (_i, state) => state.storage.sql.exec("SELECT * FROM channel").toArray());
}
/** Backdate the stored channel so ensureWatch sees it as near expiry (inside the renew buffer). */
function backdateChannel(stub: ReturnType<typeof syncStub>) {
  return withSync(stub, (_i, state) =>
    state.storage.sql.exec("UPDATE channel SET expiration_ms = ?", Date.now() + 60_000),
  );
}

/** A timed event at `startsAt` (Eastern-offset ISO); `join` is its Join Link (default: none). */
function timedEvent(
  id: string,
  startsAt: string,
  title = "Event",
  join: JoinInfo = { kind: "none" },
): ReminderEvent {
  return {
    id,
    title,
    startsAt,
    endsAt: DateTime.fromISO(startsAt).plus({ hours: 1 }).toISO(),
    join,
  };
}

/** An ISO instant `hours` from the fixed `NOW` (negative = past), Eastern offset. */
function at(hours: number): string {
  return NOW_DT.plus({ hours }).set({ second: 0, millisecond: 0 }).toISO()!;
}

// ---------------------------------------------------------------------------
// Watch lifecycle
// ---------------------------------------------------------------------------

describe("CalendarSync — ensureWatch", () => {
  it("creates and stores a channel, seeds an empty snapshot, and arms the alarm", async () => {
    const stub = syncStub();

    const status = await withSync(stub, (instance) => instance.ensureWatch());

    expect(status.active).toBe(true);
    expect(status.channelId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof status.expiresAt).toBe("number");

    // A watch channel was created at the Worker's notify address, then the baseline seeded.
    expect(fake.callsTo("watch")).toHaveLength(1);
    expect(fake.callsTo("watch")[0]!.args[0]).toBe(`${env.PUBLIC_BASE_URL}/google/notify`);
    expect(fake.callsTo("listEvents")).toHaveLength(1);

    // The channel row was stored.
    const channels = await channelRows(stub);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.id).toBe(status.channelId);
    expect(channels[0]?.resource_id).toBe("res-1");
    expect(channels[0]?.token).toBe(env.GOOGLE_WATCH_TOKEN);

    // watchStatus reports active.
    const live = await withSync(stub, (instance) => instance.watchStatus());
    expect(live.active).toBe(true);
  });

  it("leaves a healthy channel alone (no new watch, no stop)", async () => {
    const stub = syncStub();
    const first = await withSync(stub, (instance) => instance.ensureWatch());
    fake.calls.length = 0;

    const again = await withSync(stub, (instance) => instance.ensureWatch());

    expect(again.channelId).toBe(first.channelId);
    expect(fake.calls).toHaveLength(0);
  });

  it("renews a near-expiry channel: creates the replacement first, then stops the old one", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());
    const [old] = await channelRows(stub);
    await backdateChannel(stub);
    fake.calls.length = 0;
    fake.watchResponse = { resourceId: "res-2" };

    const status = await withSync(stub, (instance) => instance.ensureWatch());

    expect(status.channelId).not.toBe(old?.id);
    // Order: the watch call comes before the stop of the old channel.
    const methods = fake.calls.map((c) => c.method);
    expect(methods.indexOf("watch")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("stopChannel")).toBeGreaterThan(methods.indexOf("watch"));
    expect(fake.callsTo("stopChannel")[0]!.args).toEqual([old?.id, "res-1"]);
    const rows = await channelRows(stub);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe("res-2");
  });

  it("keeps the old channel (and never stops it) when creating the replacement fails", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());
    const [old] = await channelRows(stub);
    await backdateChannel(stub);
    fake.calls.length = 0;
    fake.failNext("watch", new Error("Google Calendar watch failed: 500 boom"));

    await expect(withSync(stub, (instance) => instance.ensureWatch())).rejects.toThrow(
      /watch failed: 500/,
    );

    expect(fake.callsTo("stopChannel")).toHaveLength(0);
    const rows = await channelRows(stub);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(old?.id);
  });
});

describe("CalendarSync — alarm renewal", () => {
  it("runs the renewal alarm without throwing", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());

    // An alarm was armed by ensureWatch; firing it re-runs ensureWatch (healthy → re-arm).
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // The channel still exists and is active afterward.
    const live = await withSync(stub, (instance) => instance.watchStatus());
    expect(live.active).toBe(true);
  });

  it("re-arms itself for a retry when the renewal fails (doesn't silently end renewal)", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());
    await backdateChannel(stub);
    // The alarm runs on whatever instance is live; `withSync` above installed the fake on it, so a
    // one-shot failure queued here is what the renewal hits.
    fake.failNext("watch", new Error("Google Calendar watch failed: 500 boom"));

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    expect(fake.callsTo("watch")).toHaveLength(2); // the initial create + the failed renewal

    const alarm = await withSync(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(Date.now());
    // The old row survived the failed renewal.
    expect(await channelRows(stub)).toHaveLength(1);
  });
});

describe("CalendarSync — stopWatch", () => {
  it("stops the channel and reports inactive afterward", async () => {
    const stub = syncStub();
    const status = await withSync(stub, (instance) => instance.ensureWatch());

    const stopped = await withSync(stub, (instance) => instance.stopWatch());
    expect(stopped).toEqual({ stopped: true });
    expect(fake.callsTo("stopChannel").map((c) => c.args)).toEqual([[status.channelId, "res-1"]]);

    const live = await withSync(stub, (instance) => instance.watchStatus());
    expect(live.active).toBe(false);
    expect(live.channelId).toBeNull();
  });

  it("reports stopped: false when there is no channel to stop", async () => {
    const stub = syncStub();
    const stopped = await withSync(stub, (instance) => instance.stopWatch());
    expect(stopped).toEqual({ stopped: false });
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps the row and alarm, and throws, when Google refuses the stop", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());
    fake.stopResult = "failed";

    await expect(withSync(stub, (instance) => instance.stopWatch())).rejects.toThrow(
      /still registered/,
    );

    expect(await channelRows(stub)).toHaveLength(1);
    const live = await withSync(stub, (instance) => instance.watchStatus());
    expect(live.active).toBe(true);
    const alarm = await withSync(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it("treats a channel Google no longer knows (gone) as stopped", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());
    fake.stopResult = "gone";

    const stopped = await withSync(stub, (instance) => instance.stopWatch());
    expect(stopped).toEqual({ stopped: true });
    expect(await channelRows(stub)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notify — channel-id gate in front of processNotification
// ---------------------------------------------------------------------------

describe("CalendarSync — notify", () => {
  it("drops a push whose channel id isn't the stored one (no calendar fetch, no Slack)", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.ensureWatch());
    fake.calls.length = 0;

    await withSync(stub, (instance) => instance.notify("not-the-stored-id", NOW));

    expect(fake.calls).toHaveLength(0);
    expect(slackPosts()).toHaveLength(0);
  });

  it("drops a push when no channel is stored at all", async () => {
    const stub = syncStub();
    await withSync(stub, (instance) => instance.notify("anything", NOW));
    expect(fake.calls).toHaveLength(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("processes a push whose channel id matches the stored one", async () => {
    const stub = syncStub();
    const status = await withSync(stub, (instance) => instance.ensureWatch());
    fake.calls.length = 0;

    await withSync(stub, (instance) => instance.notify(status.channelId!, NOW));

    expect(fake.callsTo("listEvents").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// processNotification — diff detection
// ---------------------------------------------------------------------------

describe("CalendarSync — processNotification", () => {
  it("posts a cancellation notice when an upcoming snapshot event disappears (cancelled)", async () => {
    const stub = syncStub();

    // Seed the snapshot with one upcoming timed event (Friday this week).
    fake.setEvents([timedEvent("evt-1", at(48))]);
    await withSync(stub, (instance) => instance.seed(NOW));

    // Now the event is gone from the calendar: the single-event lookup says cancelled.
    fake.setEvents([]);

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(fake.callsTo("getEvent").map((c) => c.args)).toEqual([["evt-1"]]);
    // One cancellation → posted to all three event channels.
    const posts = slackPosts();
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => rec.form(p).get("channel"))).toEqual([
      env.SLACK_ANNOUNCEMENTS_CHANNEL_ID,
      env.SLACK_EVENTS_CHANNEL_ID,
      env.SLACK_EVENTADMIN_CHANNEL_ID,
    ]);
    expect(postedText()).toContain("Cancelled");
  });

  it("posts a reschedule notice when an upcoming event's start time changes in-window", async () => {
    const stub = syncStub();

    fake.setEvents([timedEvent("evt-1", at(48))]); // Friday
    await withSync(stub, (instance) => instance.seed(NOW));

    // Same event, different start time (Saturday — still in this week's window).
    fake.setEvents([timedEvent("evt-1", at(72))]);

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(slackPosts()).toHaveLength(3);
    expect(postedText()).toContain("Rescheduled");
  });

  it("posts a reschedule notice when an upcoming event moves out of the week", async () => {
    const stub = syncStub();

    fake.setEvents([timedEvent("evt-1", at(48))]); // Friday, this week
    await withSync(stub, (instance) => instance.seed(NOW));

    // The event left this week's window but is alive at a new time (next Tuesday) — an
    // out-of-window reschedule, not a cancellation.
    fake.setEvents([timedEvent("evt-1", at(24 * 6))]);

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(fake.callsTo("getEvent").map((c) => c.args)).toEqual([["evt-1"]]);
    expect(slackPosts()).toHaveLength(3);
    expect(postedText()).toContain("Rescheduled");
  });

  it("posts nothing when a departed event turned all-day (no timed slot to correct to)", async () => {
    const stub = syncStub();

    fake.setEvents([timedEvent("evt-1", at(48))]);
    await withSync(stub, (instance) => instance.seed(NOW));

    fake.setEvents([]);
    fake.lookups.set("evt-1", { kind: "all-day" });

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(slackPosts()).toHaveLength(0);
  });

  it("posts nothing when a departed event turned invalid (a Zoom link that lost its host key)", async () => {
    const stub = syncStub();

    fake.setEvents([timedEvent("evt-1", at(48))]);
    await withSync(stub, (instance) => instance.seed(NOW));

    // The adapter now rejects it: it's no longer in the listing, and the lookup says why.
    fake.setEvents([]);
    fake.lookups.set("evt-1", { kind: "invalid", reason: "zoom-no-host-key" });

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(fake.callsTo("getEvent")).toHaveLength(1);
    expect(slackPosts()).toHaveLength(0);
  });

  it("does NOT notify when the changed event's announced start is already in the past", async () => {
    const stub = syncStub();

    // Seed an event earlier this week (Tuesday), before `NOW` (Wednesday).
    fake.setEvents([timedEvent("evt-1", at(-24))]);
    await withSync(stub, (instance) => instance.seed(NOW));

    // It disappears (cancelled) — but its announced slot already passed.
    fake.setEvents([]);

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(fake.callsTo("getEvent")).toHaveLength(0);
    expect(slackPosts()).toHaveLength(0);
  });

  it("posts nothing when the live window matches the snapshot", async () => {
    const stub = syncStub();

    fake.setEvents([timedEvent("evt-1", at(48))]);
    await withSync(stub, (instance) => instance.seed(NOW));

    await withSync(stub, (instance) => instance.processNotification(NOW));

    expect(slackPosts()).toHaveLength(0);
  });

  it("re-queues the daily starting-soon pair with the Zoom host key in the event-admin mirror", async () => {
    const stub = syncStub();

    // Later today (in the daily window), with a Zoom Join Link and its host key.
    const zoom = timedEvent("evt-1", at(6), "Event", {
      kind: "zoom",
      url: "https://us02web.zoom.us/j/81323022832?pwd=x",
      meetingId: "81323022832",
      hostKey: "123456",
    });
    fake.setEvents([zoom]);
    await withSync(stub, (instance) => instance.seed(NOW));

    await withSync(stub, (instance) => instance.processNotification(NOW));

    const scheduled = rec.callsTo("/api/chat.scheduleMessage");
    expect(scheduled).toHaveLength(2);
    expect(rec.form(scheduled[0]!).get("blocks")).not.toContain("*Host Code:*");
    expect(rec.form(scheduled[1]!).get("blocks")).toContain("*Host Code:* 123456");
  });

  it("surfaces a calendar failure instead of treating it as a change", async () => {
    const stub = syncStub();
    fake.setEvents([timedEvent("evt-1", at(48))]);
    await withSync(stub, (instance) => instance.seed(NOW));
    fake.failNext("listEvents", new Error("Google Calendar API error: 503 down"));

    await expect(
      withSync(stub, (instance) => instance.processNotification(NOW)),
    ).rejects.toThrow(/503/);

    expect(slackPosts()).toHaveLength(0);
  });

  it("commits the snapshot before delivering: one failed channel doesn't block the others or repeat on the next push", async () => {
    const stub = syncStub();
    fake.setEvents([timedEvent("evt-1", at(48))]);
    await withSync(stub, (instance) => instance.seed(NOW));

    // Cancelled; the events channel rejects the post.
    fake.setEvents([]);
    failPostsTo = new Set([env.SLACK_EVENTS_CHANNEL_ID]);

    await expect(
      withSync(stub, (instance) => instance.processNotification(NOW)),
    ).rejects.toThrow(/1 delivery failure/);

    // All three channels were attempted, and the reconcile still ran after the failure.
    expect(slackPosts()).toHaveLength(3);
    expect(rec.callsTo("/api/chat.scheduledMessages.list")).toHaveLength(1);

    // The snapshot advanced, so the next push (same calendar) has nothing to announce.
    rec.calls.length = 0;
    await withSync(stub, (instance) => instance.processNotification(NOW));
    expect(slackPosts()).toHaveLength(0);
  });
});
