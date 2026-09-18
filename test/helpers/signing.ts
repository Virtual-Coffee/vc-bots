import { hmacSha256Hex } from "../../src/crypto";

/**
 * Request-signing helpers for the provider routes. Both Slack and Zoom sign
 * `v0=HMAC-SHA256(secret, "v0:{timestamp}:{rawBody}")` (hex) over the raw body; only the header
 * names differ. `ts` defaults to now (seconds) — the verifiers reject stale timestamps.
 */

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

async function signV0(secret: string, rawBody: string, ts: string): Promise<string> {
  return `v0=${await hmacSha256Hex(secret, `v0:${ts}:${rawBody}`)}`;
}

/** The `x-zm-*` headers Zoom sends with a webhook. */
export async function signZoom(
  secret: string,
  rawBody: string,
  ts: string = nowSeconds(),
): Promise<Record<string, string>> {
  return {
    "x-zm-request-timestamp": ts,
    "x-zm-signature": await signV0(secret, rawBody, ts),
  };
}

/** The `x-slack-*` headers Slack sends with an event / interaction / command. */
export async function signSlack(
  secret: string,
  rawBody: string,
  ts: string = nowSeconds(),
): Promise<Record<string, string>> {
  return {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": await signV0(secret, rawBody, ts),
  };
}
