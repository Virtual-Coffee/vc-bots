import type { AnyMessageBlock } from "slack-cloudflare-workers";
import type { RoomChannelPort, RoomMessageStorage } from "../../src/bots/coworking/room-message";

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
  /** When set, `delete` rejects with this error. */
  deleteError: Error | null;
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
    deleteError: null,
    vanish: (ts) => vanished.add(ts),
    lastUpdateJson: () => JSON.stringify(updates.at(-1)?.blocks ?? []),
    lastPostJson: () => JSON.stringify(posts.at(-1)?.blocks ?? []),
    async post(text, blocks) {
      if (port.postWithoutTs) return null;
      const ts = `1700000000.${String(nextTs++).padStart(6, "0")}`;
      posts.push({ ts, text, blocks });
      return ts;
    },
    async update(ts, text, blocks) {
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
