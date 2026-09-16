import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fetchGoogleAccessToken } from "../src/google/auth";
import { generateServiceAccountKey, TEST_CLIENT_EMAIL } from "./helpers/google-key";

const SCOPE = "https://www.googleapis.com/auth/calendar";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let serviceAccountKey: string;
let privateKeyPem: string;

/** base64url → JSON object (the JWT payload segment). */
function decodeSegment(seg: string): Record<string, unknown> {
  let b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return JSON.parse(atob(b64));
}

beforeAll(async () => {
  ({ json: serviceAccountKey, privateKeyPem } = await generateServiceAccountKey());
});

let fetchSpy: ReturnType<typeof vi.fn>;
let goodEnv: Env;
beforeEach(() => {
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

describe("fetchGoogleAccessToken", () => {
  it("signs a JWT-bearer assertion and returns the access token + lifetime", async () => {
    const now = 1_700_000_000_000;
    expect(await fetchGoogleAccessToken(goodEnv, now)).toEqual({
      accessToken: "g-tok",
      expiresInSec: 3600,
    });

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
    expect(payload.iss).toBe(TEST_CLIENT_EMAIL);
    expect(payload.aud).toBe(TOKEN_URL);
    expect(payload.scope).toBe(SCOPE);
    expect(payload.iat).toBe(Math.floor(now / 1000));
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it("throws on a non-200 exchange without leaking the key or assertion", async () => {
    fetchSpy.mockImplementation(async () => new Response("denied", { status: 403 }));

    let message = "";
    try {
      await fetchGoogleAccessToken(goodEnv, 1_700_000_000_000);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("403");
    const assertion = await recordedAssertion(fetchSpy.mock.calls[0]!);
    expect(message).not.toContain(assertion);
    expect(message).not.toContain(privateKeyPem);
  });

  it("rejects a malformed 200 body", async () => {
    fetchSpy.mockImplementationOnce(async () => Response.json({ token_type: "Bearer" }));

    await expect(fetchGoogleAccessToken(goodEnv, 1_700_000_000_000)).rejects.toThrow(
      "Google token exchange returned an unexpected body shape",
    );
  });

  it("rejects invalid secret JSON with a redacted message and makes no fetch", async () => {
    const badEnv = { ...env, GOOGLE_SERVICE_ACCOUNT_KEY: "not json" } as Env;
    await expect(fetchGoogleAccessToken(badEnv, 1_700_000_000_000)).rejects.toThrow(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid service-account JSON",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
