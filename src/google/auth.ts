import { importPKCS8, SignJWT } from "jose";
import type { Env } from "../env";
import { log } from "../log";

/**
 * Google service-account auth (JWT-bearer grant).
 *
 * Signs a short-lived assertion with the service-account private key and exchanges it for an
 * access token at the OAuth token endpoint. Tokens last ~1h and have no refresh token, so the
 * result is cached module-level and re-fetched shortly before expiry.
 *
 * The service-account JSON, the signed assertion, and the access token are all credentials —
 * never log them.
 *
 * @see https://developers.google.com/identity/protocols/oauth2/service-account
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar";
/** Re-fetch this far ahead of expiry to avoid using a token mid-flight as it lapses. */
const EXPIRY_SKEW_MS = 60_000;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

// Best-effort per-isolate cache: no cross-request locking (unlike the DO-storage-backed Zoom
// cache), so overlapping runs may each mint a token; last-writer-wins is harmless.
let cache: CachedToken | undefined;

/** Reset the module-level token cache. Test-only. */
export function resetGoogleTokenCacheForTests(): void {
  cache = undefined;
}

function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the secret's content in the error.
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid service-account JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ServiceAccountKey).client_email !== "string" ||
    typeof (parsed as ServiceAccountKey).private_key !== "string"
  ) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid service-account JSON");
  }
  return parsed as ServiceAccountKey;
}

async function fetchGoogleAccessToken(
  env: Env,
  nowMs: number,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const { client_email, private_key } = parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_KEY);

  const key = await importPKCS8(private_key, "RS256");
  const nowSec = Math.floor(nowMs / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    // Google's {error, error_description} body is safe to surface; the assertion is not.
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json<{ access_token?: string; expires_in?: number }>();
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error("Google token exchange returned an unexpected body shape");
  }
  return { accessToken: body.access_token, expiresInSec: body.expires_in };
}

/**
 * Return a valid Google access token, reusing the cached one until it nears expiry.
 * `nowMs` is injectable for tests.
 */
export async function getGoogleAccessToken(
  env: Env,
  nowMs: number = Date.now(),
): Promise<string> {
  if (cache && cache.expiresAtMs - EXPIRY_SKEW_MS > nowMs) {
    log.debug("google.token.cache_hit");
    return cache.accessToken;
  }
  log.debug("google.token.fetch");
  const { accessToken, expiresInSec } = await fetchGoogleAccessToken(env, nowMs);
  cache = { accessToken, expiresAtMs: nowMs + expiresInSec * 1000 };
  log.debug("google.token.fetched", { expiresInSec });
  return accessToken;
}
