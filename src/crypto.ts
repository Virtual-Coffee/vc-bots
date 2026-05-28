/**
 * Web Crypto helpers shared by the Slack and Zoom signature verifiers.
 *
 * Uses `crypto.subtle` only — no `node:crypto`. Signature *verification* goes through
 * `crypto.subtle.verify`, which compares in constant time internally, so we never hand-roll
 * a timing-safe string compare.
 */

const encoder = new TextEncoder();

async function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Lowercase hex HMAC-SHA256 of `message` keyed by `secret`. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Constant-time verification that `signatureHex` is a valid HMAC-SHA256 of `message`
 * under `secret`. Returns false for malformed hex rather than throwing.
 */
export async function verifyHmacSha256(
  secret: string,
  message: string,
  signatureHex: string,
): Promise<boolean> {
  const signature = hexToBytes(signatureHex);
  if (signature === null) return false;
  const key = await importHmacKey(secret, "verify");
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(message));
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Parse a lowercase/uppercase hex string to bytes; returns null if not valid hex. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
