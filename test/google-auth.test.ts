import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { getGoogleAccessToken, resetGoogleTokenCacheForTests } from "../src/google/auth";

const CLIENT_EMAIL = "sa@test.iam.gserviceaccount.com";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let serviceAccountKey: string;
let privateKeyPem: string;

function toPem(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** base64url → JSON object (the JWT payload segment). */
function decodeSegment(seg: string): Record<string, unknown> {
  let b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return JSON.parse(atob(b64));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  privateKeyPem = toPem(pkcs8);
  serviceAccountKey = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: privateKeyPem });
});

let fetchSpy: ReturnType<typeof vi.fn>;
let goodEnv: Env;
beforeEach(() => {
  resetGoogleTokenCacheForTests();
  fetchSpy = vi.fn(async () => Response.json({ access_token: "g-tok", expires_in: 3600 }));
  vi.stubGlobal("fetch", fetchSpy);
  goodEnv = { ...env, GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey } as Env;
});
afterEach(() => vi.unstubAllGlobals());

/** Pull the form-encoded `assertion` field out of a recorded fetch call. */
async function recordedAssertion(call: unknown[]): Promise<string> {
  const [input, init] = call as [unknown, { body?: unknown } | undefined];
  let bodyText: string;
  if (input instanceof Request) {
    bodyText = await input.clone().text();
  } else {
    const body = init?.body;
    bodyText = body instanceof URLSearchParams ? body.toString() : String(body);
  }
  return new URLSearchParams(bodyText).get("assertion") ?? "";
}

describe("getGoogleAccessToken", () => {
  it("signs a JWT-bearer assertion and returns the access token", async () => {
    const now = 1_700_000_000_000;
    expect(await getGoogleAccessToken(goodEnv, now)).toBe("g-tok");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0] as [unknown, { body?: unknown }];
    expect(input instanceof Request ? input.url : String(input)).toBe(TOKEN_URL);

    const bodyText =
      init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const params = new URLSearchParams(bodyText);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const assertion = params.get("assertion") ?? "";
    const segments = assertion.split(".");
    expect(segments).toHaveLength(3);

    const payload = decodeSegment(segments[1]!);
    expect(payload.iss).toBe(CLIENT_EMAIL);
    expect(payload.aud).toBe(TOKEN_URL);
    expect(payload.scope).toBe(SCOPE);
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it("serves from cache while the token is valid", async () => {
    const now = 1_700_000_000_000;
    await getGoogleAccessToken(goodEnv, now);
    await getGoogleAccessToken(goodEnv, now);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the token nears expiry", async () => {
    const now = 1_700_000_000_000;
    await getGoogleAccessToken(goodEnv, now);
    // 3600s lifetime; jump past the 60s-skew window to force a refresh.
    await getGoogleAccessToken(goodEnv, now + 3_600_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-200 exchange without leaking the key or assertion", async () => {
    fetchSpy.mockImplementation(async () => new Response("denied", { status: 403 }));

    let message = "";
    try {
      await getGoogleAccessToken(goodEnv, 1_700_000_000_000);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("403");
    const assertion = await recordedAssertion(fetchSpy.mock.calls[0]!);
    expect(message).not.toContain(assertion);
    expect(message).not.toContain(privateKeyPem);
  });

  it("rejects a malformed 200 body without poisoning the cache", async () => {
    fetchSpy.mockImplementationOnce(async () => Response.json({ token_type: "Bearer" }));

    await expect(getGoogleAccessToken(goodEnv, 1_700_000_000_000)).rejects.toThrow(
      "Google token exchange returned an unexpected body shape",
    );
    // Next call (good response) succeeds — the bad body cached nothing.
    expect(await getGoogleAccessToken(goodEnv, 1_700_000_000_000)).toBe("g-tok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid secret JSON with a redacted message and makes no fetch", async () => {
    const badEnv = { ...env, GOOGLE_SERVICE_ACCOUNT_KEY: "not json" } as Env;
    await expect(getGoogleAccessToken(badEnv, 1_700_000_000_000)).rejects.toThrow(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid service-account JSON",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
