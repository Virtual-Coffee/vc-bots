import type { Env } from "../env";
import { log } from "../log";

/**
 * Zoom Server-to-Server OAuth.
 *
 * Mints an account-credentials access token (Basic-auth client_id:client_secret).
 * Tokens last ~1h and have no refresh token, so `getCachedZoomToken` caches the token in the
 * Durable Object's storage and re-fetches shortly before expiry.
 *
 * @see https://developers.zoom.us/docs/internal-apps/s2s-oauth/
 */

const ZOOM_OAUTH_TOKEN_URL = "https://zoom.us/oauth/token";

export interface ZoomTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export async function fetchZoomAccessToken(env: Env): Promise<ZoomTokenResponse> {
  const url = new URL(ZOOM_OAUTH_TOKEN_URL);
  url.searchParams.set("grant_type", "account_credentials");
  url.searchParams.set("account_id", env.ZOOM_S2S_ACCOUNT_ID);

  const basic = btoa(`${env.ZOOM_S2S_CLIENT_ID}:${env.ZOOM_S2S_CLIENT_SECRET}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    throw new Error(`Zoom S2S OAuth failed: ${res.status} ${await res.text()}`);
  }
  return res.json<ZoomTokenResponse>();
}

/** Minimal key/value storage shape (satisfied by `DurableObjectStorage`). */
export interface TokenCacheStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const TOKEN_CACHE_KEY = "zoom_s2s_token";
/** Re-fetch this far ahead of expiry to avoid using a token mid-flight as it lapses. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Return a valid Zoom access token, reusing the cached one until it nears expiry.
 * `nowMs` is injectable for tests.
 */
export async function getCachedZoomToken(
  env: Env,
  storage: TokenCacheStorage,
  nowMs: number = Date.now(),
): Promise<string> {
  const cached = await storage.get<CachedToken>(TOKEN_CACHE_KEY);
  if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > nowMs) {
    log.debug("zoom.token.cache_hit");
    return cached.accessToken;
  }
  log.debug("zoom.token.fetch");
  const fresh = await fetchZoomAccessToken(env);
  await storage.put<CachedToken>(TOKEN_CACHE_KEY, {
    accessToken: fresh.access_token,
    expiresAtMs: nowMs + fresh.expires_in * 1000,
  });
  log.debug("zoom.token.fetched", { expiresInSec: fresh.expires_in });
  return fresh.access_token;
}
