import type { AnyMessageBlock } from "slack-cloudflare-workers";
import type { CoworkingRoom } from "../../src/bots/coworking/durable-object";
import {
  RoomMessage,
  type RoomChannelPort,
  type RoomMessageStorage,
} from "../../src/bots/coworking/room-message";
import type { Env } from "../../src/env";

/**
 * An in-memory `RoomChannelPort`: records every post / update / delete with its text and blocks,
 * hands out incrementing ts values, and lets a test declare a ts vanished (deleted by hand) so
 * updates against it report `"vanished"` the way the Slack adapter does.
 */

export interface FakeMessage {
  ts: string;
  text: string;
  blocks: AnyMessageBlock[];
}

export interface FakeUpdate extends FakeMessage {
  result: "ok" | "vanished";
}

export interface FakeRoomChannelPort extends RoomChannelPort {
  readonly posts: FakeMessage[];
  readonly updates: FakeUpdate[];
  readonly deletes: string[];
  /** Updates against this ts report `"vanished"` from now on. */
  vanish(ts: string): void;
  /** When true, `post` resolves to null (Slack answered without a ts). */
  postWithoutTs: boolean;
  /** When set, `update` rejects with this error (a non-vanished Slack failure) instead of recording. */
  updateError: Error | null;
  /** When set, `delete` rejects with this error. */
  deleteError: Error | null;
  /**
   * When set, every `post` / `update` parks on this promise before recording — the in-flight
   * Slack call the DO's event queue exists to serialize behind (ADR 0003). `attempts` counts
   * calls as they *enter* (parked ones included), so a test can wait for the DO to be parked.
   */
  hold: { posts: Promise<void> | null; updates: Promise<void> | null };
  readonly attempts: { posts: number; updates: number };
  /** The most recent update's blocks as JSON, for substring assertions. */
  lastUpdateJson(): string;
  /** The most recent post's blocks as JSON, for substring assertions. */
  lastPostJson(): string;
}

export function createFakeRoomChannelPort(): FakeRoomChannelPort {
  const posts: FakeMessage[] = [];
  const updates: FakeUpdate[] = [];
  const deletes: string[] = [];
  const vanished = new Set<string>();
  let nextTs = 1;

  const port: FakeRoomChannelPort = {
    posts,
    updates,
    deletes,
    postWithoutTs: false,
    updateError: null,
    deleteError: null,
    hold: { posts: null, updates: null },
    attempts: { posts: 0, updates: 0 },
    vanish: (ts) => vanished.add(ts),
    lastUpdateJson: () => JSON.stringify(updates.at(-1)?.blocks ?? []),
    lastPostJson: () => JSON.stringify(posts.at(-1)?.blocks ?? []),
    async post(text, blocks) {
      port.attempts.posts++;
      if (port.hold.posts) await port.hold.posts;
      if (port.postWithoutTs) return null;
      const ts = `1700000000.${String(nextTs++).padStart(6, "0")}`;
      posts.push({ ts, text, blocks });
      return ts;
    },
    async update(ts, text, blocks) {
      port.attempts.updates++;
      if (port.hold.updates) await port.hold.updates;
      if (port.updateError) throw port.updateError;
      const result = vanished.has(ts) ? "vanished" : "ok";
      updates.push({ ts, text, blocks, result });
      return result;
    },
    async delete(ts) {
      if (port.deleteError) throw port.deleteError;
      deletes.push(ts);
    },
  };
  return port;
}

/** A Map-backed stand-in for the slice of Durable Object storage `RoomMessage` uses. */
export function createMemoryStorage(): RoomMessageStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const storage = {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => map.delete(key),
  };
  return storage as unknown as RoomMessageStorage & { map: Map<string, unknown> };
}

/**
 * Point the DO's `RoomMessage` at `port` (a fresh RoomMessage over the DO's own storage, so the
 * pointer keys behave exactly as in production). Use inside `runInDurableObject`, where the live
 * instance is in hand; the field — and the DO's `ctx` / `env` — are private, hence the cast.
 */
export function installRoomChannelFake(instance: CoworkingRoom, port: RoomChannelPort): void {
  const live = instance as unknown as {
    ctx: DurableObjectState;
    env: Env;
    roomMessage: RoomMessage;
  };
  live.roomMessage = new RoomMessage(port, live.ctx.storage, live.env);
}
