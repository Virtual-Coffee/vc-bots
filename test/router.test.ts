import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { route } from "../src/router";

/** The unsigned routes: the health check, its HEAD / twin, and the 404 default. */

async function send(method: string, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await route(new Request(`https://bots.example${path}`, { method }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("route", () => {
  it("GET /health → 200 ok", async () => {
    const res = await send("GET", "/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("HEAD / → 200 (uptime pings)", async () => {
    const res = await send("HEAD", "/");
    expect(res.status).toBe(200);
  });

  it("GET /nope → 404", async () => {
    const res = await send("GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("POST /health → 404 (the health check is GET-only)", async () => {
    const res = await send("POST", "/health");
    expect(res.status).toBe(404);
  });
});
