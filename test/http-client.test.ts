import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, createApiClient } from "../src/http/client";
import { ApiError } from "../src/http/error";

interface Paths {
  "/thing": {
    get: {
      responses: { 200: { content: { "application/json": { ok: true } } } };
    };
  };
}

describe("createApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the global fetch in place at call time, not at client creation", async () => {
    const client = createApiClient<Paths>({ baseUrl: "https://api.example" });
    const spy = vi.fn(async (_req: Request) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", spy);

    const { data } = await client.GET("/thing");

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0].url).toBe("https://api.example/thing");
    expect(data).toEqual({ ok: true });
  });

  it("sets the bearer header from the resolver on every call", async () => {
    let calls = 0;
    const client = createApiClient<Paths>({
      baseUrl: "https://api.example",
      bearer: () => `tok-${++calls}`,
    });
    const spy = vi.fn(async (req: Request) =>
      Response.json({ auth: req.headers.get("Authorization") }),
    );
    vi.stubGlobal("fetch", spy);

    await client.GET("/thing");
    await client.GET("/thing");

    const [first, second] = spy.mock.calls.map(([req]) => req.headers.get("Authorization"));
    expect(first).toBe("Bearer tok-1");
    expect(second).toBe("Bearer tok-2");
  });
});

describe("apiError", () => {
  const response = (status: number) => new Response(null, { status });

  it("keeps a plain-text body verbatim", () => {
    const err = apiError("google", "Google Calendar API error", {
      response: response(403),
      error: "Forbidden",
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Google Calendar API error: 403 Forbidden");
    expect(err.provider).toBe("google");
    expect(err.status).toBe(403);
    expect(err.body).toBe("Forbidden");
  });

  it("re-stringifies a parsed JSON body", () => {
    const err = apiError("zoom", "Zoom invite-links failed", {
      response: response(404),
      error: { code: 3001, message: "Meeting does not exist" },
    });
    expect(err.message).toBe(
      'Zoom invite-links failed: 404 {"code":3001,"message":"Meeting does not exist"}',
    );
    expect(err.body).toEqual({ code: 3001, message: "Meeting does not exist" });
  });

  it("renders an absent body as empty", () => {
    const err = apiError("google", "Google token exchange failed", { response: response(500) });
    expect(err.message).toBe("Google token exchange failed: 500 ");
  });
});
