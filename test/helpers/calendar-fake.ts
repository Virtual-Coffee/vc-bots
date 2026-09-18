import { DateTime } from "luxon";
import type { CalendarSync } from "../../src/bots/calendar-sync/durable-object";
import type { EventRange, ReminderEvent } from "../../src/events";
import type {
  CalendarEventLookup,
  CalendarPort,
  CalendarWatch,
  StopChannelResult,
} from "../../src/google/calendar";

/**
 * An in-memory `CalendarPort`: holds the calendar as a map of `ReminderEvent`s, answers
 * `listEvents` with the ones inside the range, `getEvent` from the same map (missing → cancelled,
 * or a per-id override), and records every call so a test can assert the watch / stop / list
 * traffic without a fetch spy. `failNext` makes one call of a method throw.
 */

export type CalendarMethod = keyof CalendarPort;

export interface CalendarCall {
  method: CalendarMethod;
  args: unknown[];
}

export interface FakeCalendar extends CalendarPort {
  readonly calls: CalendarCall[];
  callsTo(method: CalendarMethod): CalendarCall[];
  /** Replace the whole calendar. */
  setEvents(events: ReminderEvent[]): void;
  /** Per-id `getEvent` answers that win over the map (e.g. `{ kind: "all-day" }` or
   *  `{ kind: "invalid", reason: "zoom-no-host-key" }`). */
  readonly lookups: Map<string, CalendarEventLookup>;
  /** What the next `watch` returns; missing fields get defaults (fresh uuid, `res-1`, now + 7d). */
  watchResponse: Partial<CalendarWatch>;
  /** What `stopChannel` returns (after the `null` resourceId → `"gone"` rule). */
  stopResult: StopChannelResult;
  /** Make the next call of `method` throw `error` (one-shot). */
  failNext(method: CalendarMethod, error: Error): void;
  /**
   * When set, every `listEvents` parks on this promise before answering — the in-flight Google
   * call the DO's queue exists to serialize behind (ADR 0003). `attempts` counts calls as they
   * *enter* (parked ones included), so a test can wait for the DO to be parked.
   */
  hold: { listEvents: Promise<void> | null };
  readonly attempts: { listEvents: number };
}

const WEEK_MS = 7 * 86_400_000;

export function createCalendarFake(initial: ReminderEvent[] = []): FakeCalendar {
  const events = new Map<string, ReminderEvent>();
  const calls: CalendarCall[] = [];
  const lookups = new Map<string, CalendarEventLookup>();
  const failures = new Map<CalendarMethod, Error>();

  const record = (method: CalendarMethod, ...args: unknown[]): void => {
    calls.push({ method, args });
    const error = failures.get(method);
    if (error) {
      failures.delete(method);
      throw error;
    }
  };
  const millis = (iso: string): number => DateTime.fromISO(iso, { setZone: true }).toMillis();

  const fake: FakeCalendar = {
    calls,
    lookups,
    watchResponse: {},
    stopResult: "stopped",
    hold: { listEvents: null },
    attempts: { listEvents: 0 },
    callsTo: (method) => calls.filter((c) => c.method === method),
    setEvents(next) {
      events.clear();
      for (const e of next) events.set(e.id, e);
    },
    failNext: (method, error) => failures.set(method, error),

    async listEvents(range: EventRange) {
      fake.attempts.listEvents++;
      if (fake.hold.listEvents) await fake.hold.listEvents;
      record("listEvents", range);
      const start = millis(range.rangeStart);
      const end = millis(range.rangeEnd);
      return [...events.values()]
        .filter((e) => {
          const at = millis(e.startsAt);
          return at >= start && at < end;
        })
        .sort((a, b) => millis(a.startsAt) - millis(b.startsAt));
    },

    async getEvent(id) {
      record("getEvent", id);
      const override = lookups.get(id);
      if (override) return override;
      const event = events.get(id);
      return event ? { kind: "live", event } : { kind: "cancelled" };
    },

    async watch(address) {
      record("watch", address);
      return {
        channelId: fake.watchResponse.channelId ?? crypto.randomUUID(),
        resourceId: fake.watchResponse.resourceId ?? "res-1",
        expirationMs: fake.watchResponse.expirationMs ?? Date.now() + WEEK_MS,
      };
    },

    async stopChannel(channelId, resourceId) {
      record("stopChannel", channelId, resourceId);
      if (!resourceId) return "gone";
      return fake.stopResult;
    },
  };
  fake.setEvents(initial);
  return fake;
}

/**
 * Swap the DO's calendar port for `fake`. Use inside `runInDurableObject`, where the live
 * instance is in hand; the field is private, hence the cast.
 */
export function installCalendarFake(instance: CalendarSync, fake: CalendarPort): void {
  (instance as unknown as { calendar: CalendarPort }).calendar = fake;
}
