import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLogLevel } from "../src/log";
import { deleteOriginal, respondEphemeral } from "../src/slack/response";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setLogLevel("warn");
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLogLevel("warn");
});

function warnLines(): string[] {
  return warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
}

describe("response_url helpers fail soft", () => {
  it("logs (does not throw) when the response_url fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(respondEphemeral("https://hooks.slack.test/x", "hi")).resolves.toBeUndefined();
    expect(warnLines().join("\n")).toContain("slack.response_url.error action=respondEphemeral");
  });

  it("logs (does not throw) when Slack returns a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(deleteOriginal("https://hooks.slack.test/x")).resolves.toBeUndefined();
    expect(warnLines().join("\n")).toContain("slack.response_url.not_ok action=deleteOriginal status=500");
  });
});
