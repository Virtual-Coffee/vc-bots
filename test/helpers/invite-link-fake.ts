import type { CoworkingRoom } from "../../src/bots/coworking/durable-object";
import { type InviteLinks, createInviteLinks } from "../../src/bots/coworking/invite-link";
import type { Env } from "../../src/env";
import type { InviteLinkPort } from "../../src/zoom/invite-links";

/**
 * An in-memory `InviteLinkPort`: records every display name minted and answers with one fixed
 * `joinUrl` (no Zoom OAuth, no HTTP). `failNext` makes the next mint throw, the way the real
 * adapter does when Zoom rejects the call.
 */

export interface FakeInviteLinks extends InviteLinkPort {
  /** Display names handed to `mint`, in order. */
  readonly mints: string[];
  /** The `ttlSeconds` handed to each `mint`, in order. */
  readonly ttls: number[];
  /** What every mint resolves to. */
  joinUrl: string;
  /** Make the next `mint` throw `error` (one-shot). */
  failNext(error?: Error): void;
}

export function createInviteLinkFake(opts: { joinUrl?: string } = {}): FakeInviteLinks {
  const mints: string[] = [];
  const ttls: number[] = [];
  let failure: Error | null = null;

  const fake: FakeInviteLinks = {
    mints,
    ttls,
    joinUrl: opts.joinUrl ?? "https://zoom.us/w/personal-1",
    failNext: (error = new Error("Zoom invite-links failed: 400")) => {
      failure = error;
    },
    async mint(displayName, ttlSeconds) {
      mints.push(displayName);
      ttls.push(ttlSeconds);
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      return { joinUrl: fake.joinUrl };
    },
  };
  return fake;
}

/**
 * Point the DO's invite-link store at `fake` (a fresh store over the DO's own SQLite, so the
 * tables behave exactly as in production). Use inside `runInDurableObject`, where the live
 * instance is in hand; the field — and the DO's `ctx` / `env` — are private, hence the cast.
 */
export function installInviteLinkFake(instance: CoworkingRoom, fake: InviteLinkPort): void {
  const live = instance as unknown as {
    ctx: DurableObjectState;
    env: Env;
    inviteLinks: InviteLinks;
  };
  live.inviteLinks = createInviteLinks(live.ctx.storage.sql, fake, live.env);
}
