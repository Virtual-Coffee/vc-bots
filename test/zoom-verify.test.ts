import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto";
import { buildZoomUrlValidationResponse, verifyZoomSignature } from "../src/zoom/verify";

const SECRET = "zoom_webhook_secret_token_example";

async function sign(rawBody: string, timestamp: string): Promise<string> {
  return `v0=${await hmacSha256Hex(SECRET, `v0:${timestamp}:${rawBody}`)}`;
}

describe("verifyZoomSignature", () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const rawBody = JSON.stringify({ event: "meeting.started", payload: { object: { id: "123" } } });

  it("accepts a correctly signed request (round-trip)", async () => {
    const signature = await sign(rawBody, timestamp);
    expect(
      await verifyZoomSignature({ secretToken: SECRET, rawBody, timestamp, signature, nowMs }),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(rawBody, timestamp);
    expect(
      await verifyZoomSignature({ secretToken: SECRET, rawBody: "{}", timestamp, signature, nowMs }),
    ).toBe(false);
  });

  it("rejects an expired timestamp", async () => {
    const oldTs = String(Math.floor(nowMs / 1000) - 600);
    const signature = await sign(rawBody, oldTs);
    expect(
      await verifyZoomSignature({ secretToken: SECRET, rawBody, timestamp: oldTs, signature, nowMs }),
    ).toBe(false);
  });
});

describe("buildZoomUrlValidationResponse", () => {
  it("returns plainToken + its HMAC-SHA256 hex (the url_validation vector)", async () => {
    const plainToken = "qgg8vlvZRS6UYooatFL8Aw";
    const res = await buildZoomUrlValidationResponse(SECRET, plainToken);

    expect(res.plainToken).toBe(plainToken);
    // encryptedToken must be the HMAC of the plainToken under the secret token.
    expect(res.encryptedToken).toBe(await hmacSha256Hex(SECRET, plainToken));
    // ...and a well-formed 64-char SHA-256 hex digest.
    expect(res.encryptedToken).toMatch(/^[0-9a-f]{64}$/);
  });
});
