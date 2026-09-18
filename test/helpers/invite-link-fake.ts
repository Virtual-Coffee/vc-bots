import type { CoworkingRoom } from "../../src/bots/coworking/durable-object";
import type { InviteLinkPort } from "../../src/zoom/invite-links";

/**
 * An in-memory `InviteLinkPort`: records every display name minted and answers with one fixed
 * `joinUrl` (no Zoom OAuth, no HTTP). `failNext` makes the next mint throw, the way the real
 * adapter does when Zoom rejects the call.
 */

export interface FakeInviteLinks extends InviteLinkPort {
  /** Display names handed to `mint`, in order. */
  readonly mints: string[];
  /** What every mint resolves to. */
  joinUrl: string;
  /** Make the next `mint` throw `error` (one-shot). */
  failNext(error?: Error): void;
}

export function createInviteLinkFake(opts: { joinUrl?: string } = {}): FakeInviteLinks {
  const mints: string[] = [];
  let failure: Error | null = null;

  const fake: FakeInviteLinks = {
    mints,
    joinUrl: opts.joinUrl ?? "https://zoom.us/w/personal-1",
    failNext: (error = new Error("Zoom invite-links failed: 400")) => {
      failure = error;
    },
    async mint(displayName) {
      mints.push(displayName);
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
 * Swap the DO's invite-link port for `fake`. Use inside `runInDurableObject`, where the live
 * instance is in hand; the field is private, hence the cast.
 */
export function installInviteLinkFake(instance: CoworkingRoom, fake: InviteLinkPort): void {
  (instance as unknown as { inviteLinks: InviteLinkPort }).inviteLinks = fake;
}
