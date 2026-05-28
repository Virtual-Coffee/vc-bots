import { hmacSha256Hex, verifyHmacSha256 } from "../crypto";

/**
 * Zoom webhook signature verification + endpoint URL validation (Web Crypto).
 *
 * Zoom signs `v0:{timestamp}:{rawBody}` with the webhook secret token and sends
 * `x-zm-signature: v0=<hex>` plus `x-zm-request-timestamp`.
 *
 * The `endpoint.url_validation` challenge is answered by returning the `plainToken`
 * alongside its HMAC-SHA256 hex (`encryptedToken`).
 *
 * @see https://developers.zoom.us/docs/api/webhooks/
 */

const FIVE_MINUTES_SEC = 60 * 5;

export interface ZoomVerifyOptions {
  secretToken: string;
  rawBody: string;
  /** `x-zm-request-timestamp` header value. */
  timestamp: string | null;
  /** `x-zm-signature` header value (`v0=<hex>`). */
  signature: string | null;
  nowMs?: number;
  toleranceSec?: number;
}

export async function verifyZoomSignature(opts: ZoomVerifyOptions): Promise<boolean> {
  const { secretToken, rawBody, timestamp, signature } = opts;
  if (!timestamp || !signature) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;

  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSec ?? FIVE_MINUTES_SEC;
  if (Math.abs(nowSec - ts) > tolerance) return false;

  if (!signature.startsWith("v0=")) return false;
  const providedHex = signature.slice(3);

  const base = `v0:${timestamp}:${rawBody}`;
  return verifyHmacSha256(secretToken, base, providedHex);
}

/** Convenience: pull the signing headers off a Request and verify. */
export async function verifyZoomRequest(
  req: Request,
  rawBody: string,
  secretToken: string,
  nowMs?: number,
): Promise<boolean> {
  return verifyZoomSignature({
    secretToken,
    rawBody,
    timestamp: req.headers.get("x-zm-request-timestamp"),
    signature: req.headers.get("x-zm-signature"),
    nowMs,
  });
}

export interface ZoomUrlValidationResponse {
  plainToken: string;
  encryptedToken: string;
}

/** Build the `endpoint.url_validation` challenge response. */
export async function buildZoomUrlValidationResponse(
  secretToken: string,
  plainToken: string,
): Promise<ZoomUrlValidationResponse> {
  return { plainToken, encryptedToken: await hmacSha256Hex(secretToken, plainToken) };
}
