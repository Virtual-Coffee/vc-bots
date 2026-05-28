import { verifyHmacSha256 } from "../crypto";

/**
 * Slack request signature verification (Web Crypto).
 *
 * Slack signs `v0:{timestamp}:{rawBody}` with the app signing secret and sends the result
 * as `X-Slack-Signature: v0=<hex>`, with the unix timestamp in `X-Slack-Request-Timestamp`.
 * We reject requests outside a ±5-minute window to mitigate replay.
 *
 * Read the raw body exactly once (`await req.text()`) and verify BEFORE parsing.
 *
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack/
 */

const FIVE_MINUTES_SEC = 60 * 5;

export interface SlackVerifyOptions {
  signingSecret: string;
  rawBody: string;
  /** `X-Slack-Request-Timestamp` header value. */
  timestamp: string | null;
  /** `X-Slack-Signature` header value (`v0=<hex>`). */
  signature: string | null;
  /** Override for tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** Replay window in seconds; defaults to 300. */
  toleranceSec?: number;
}

export async function verifySlackSignature(opts: SlackVerifyOptions): Promise<boolean> {
  const { signingSecret, rawBody, timestamp, signature } = opts;
  if (!timestamp || !signature) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;

  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSec ?? FIVE_MINUTES_SEC;
  if (Math.abs(nowSec - ts) > tolerance) return false;

  if (!signature.startsWith("v0=")) return false;
  const providedHex = signature.slice(3);

  const base = `v0:${timestamp}:${rawBody}`;
  return verifyHmacSha256(signingSecret, base, providedHex);
}

/** Convenience: pull the signing headers off a Request and verify. */
export async function verifySlackRequest(
  req: Request,
  rawBody: string,
  signingSecret: string,
  nowMs?: number,
): Promise<boolean> {
  return verifySlackSignature({
    signingSecret,
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    nowMs,
  });
}
