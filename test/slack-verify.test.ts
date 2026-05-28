import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto";
import { verifySlackSignature } from "../src/slack/verify";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

/** Build a valid `v0=<hex>` Slack signature for a body+timestamp. */
async function sign(rawBody: string, timestamp: string): Promise<string> {
  return `v0=${await hmacSha256Hex(SIGNING_SECRET, `v0:${timestamp}:${rawBody}`)}`;
}

describe("verifySlackSignature", () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const rawBody = JSON.stringify({ type: "event_callback", event: { type: "team_join" } });

  it("accepts a correctly signed request (round-trip)", async () => {
    const signature = await sign(rawBody, timestamp);
    expect(
      await verifySlackSignature({ signingSecret: SIGNING_SECRET, rawBody, timestamp, signature, nowMs }),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(rawBody, timestamp);
    expect(
      await verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody: rawBody + " ",
        timestamp,
        signature,
        nowMs,
      }),
    ).toBe(false);
  });

  it("rejects the wrong signing secret", async () => {
    const signature = await sign(rawBody, timestamp);
    expect(
      await verifySlackSignature({ signingSecret: "nope", rawBody, timestamp, signature, nowMs }),
    ).toBe(false);
  });

  it("rejects a timestamp outside the replay window", async () => {
    const oldTs = String(Math.floor(nowMs / 1000) - 600); // 10 min old
    const signature = await sign(rawBody, oldTs);
    expect(
      await verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp: oldTs,
        signature,
        nowMs,
      }),
    ).toBe(false);
  });

  it("rejects missing headers", async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp: null,
        signature: null,
        nowMs,
      }),
    ).toBe(false);
  });

  it("rejects a malformed signature (no v0= prefix / bad hex)", async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp,
        signature: "deadbeef",
        nowMs,
      }),
    ).toBe(false);
    expect(
      await verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp,
        signature: "v0=zzzz",
        nowMs,
      }),
    ).toBe(false);
  });
});
