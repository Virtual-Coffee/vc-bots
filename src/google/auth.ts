import { importPKCS8, SignJWT } from "jose";
import type { Env } from "../env";
import type { paths } from "../generated/google-oauth-token";
import { apiError, createApiClient } from "../http/client";

/**
 * Google service-account auth (JWT-bearer grant).
 *
 * Signs a short-lived assertion with the service-account private key and exchanges it for an
 * access token at the OAuth token endpoint. This is the pure sign-and-exchange step; tokens last
 * ~1h and have no refresh token, so the Calendar adapter (`src/google/calendar.ts`) caches the
 * result per instance and re-fetches shortly before expiry.
 *
 * The service-account JSON, the signed assertion, and the access token are all credentials —
 * never log them.
 *
 * @see https://developers.google.com/identity/protocols/oauth2/service-account
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

const oauth = createApiClient<paths>({ baseUrl: "https://oauth2.googleapis.com" });

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
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

/**
 * Mint a fresh access token: sign the JWT-bearer assertion at `nowMs` and exchange it. No
 * caching here — callers own that.
 */
export async function fetchGoogleAccessToken(
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

  const { data, error, response } = await oauth.POST("/token", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion },
  });

  if (!response.ok) {
    // Google's {error, error_description} body is safe to surface; the assertion is not.
    throw apiError("google", "Google token exchange failed", { response, error });
  }

  if (typeof data?.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new Error("Google token exchange returned an unexpected body shape");
  }
  return { accessToken: data.access_token, expiresInSec: data.expires_in };
}
