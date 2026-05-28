import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { getCachedZoomToken } from "../src/zoom/oauth";

const env = {
  ZOOM_S2S_CLIENT_ID: "cid",
  ZOOM_S2S_CLIENT_SECRET: "secret",
  ZOOM_S2S_ACCOUNT_ID: "acc",
} as Env;

/** In-memory storage satisfying the TokenCacheStorage shape. */
function memStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => map.get(k) as T | undefined,
    put: async <T>(k: string, v: T) => void map.set(k, v),
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () =>
    Response.json({ access_token: "tok-1", token_type: "bearer", expires_in: 3600 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("getCachedZoomToken", () => {
  it("fetches once, then serves from cache while valid", async () => {
    const storage = memStorage();
    const now = 1_000_000;

    expect(await getCachedZoomToken(env, storage, now)).toBe("tok-1");
    expect(await getCachedZoomToken(env, storage, now + 60_000)).toBe("tok-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the token nears expiry", async () => {
    const storage = memStorage();
    const now = 1_000_000;

    await getCachedZoomToken(env, storage, now);
    // 3600s lifetime; jump past it so the 60s-skew window forces a refresh.
    await getCachedZoomToken(env, storage, now + 3_600_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
