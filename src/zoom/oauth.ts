import type { Env } from "../env";
import type { components, paths } from "../generated/zoom-oauth-token";
import { apiError, createApiClient } from "../http/client";
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

/** REST base every S2S-authenticated Zoom call (invite links) is made against. */
export const ZOOM_API_BASE = "https://api.zoom.us/v2";

const oauth = createApiClient<paths>({ baseUrl: "https://zoom.us" });

export type ZoomTokenResponse = components["schemas"]["TokenResponse"];

export async function fetchZoomAccessToken(env: Env): Promise<ZoomTokenResponse> {
  const basic = btoa(`${env.ZOOM_S2S_CLIENT_ID}:${env.ZOOM_S2S_CLIENT_SECRET}`);
  const { data, error, response } = await oauth.POST("/oauth/token", {
    params: {
      query: { grant_type: "account_credentials", account_id: env.ZOOM_S2S_ACCOUNT_ID },
    },
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    throw apiError("zoom", "Zoom S2S OAuth failed", { response, error });
  }
  if (typeof data?.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new Error("Zoom S2S OAuth returned an unexpected body shape");
  }
  return data;
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
