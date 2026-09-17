import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLogLevel } from "../src/log";
import { deleteOriginal, replaceEphemeral, respondEphemeral } from "../src/slack/response";

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

/** Stub `fetch` with a 200 and hand back the JSON body of the one call it received. */
function captureBody(): () => Record<string, unknown> {
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return () => {
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  };
}

describe("response_url helpers pin their guardrails", () => {
  // These two fields are the whole reason the helpers exist (ADR 0004): `response_type` keeps a
  // reply private, and `replace_original` decides whether the "original" — for the channel
  // button, the shared room message — gets overwritten.
  it("respondEphemeral posts a new ephemeral (replace_original: false)", async () => {
    const body = captureBody();
    await respondEphemeral("https://hooks.slack.test/x", "hi");
    expect(body()).toMatchObject({ response_type: "ephemeral", replace_original: false, text: "hi" });
  });

  it("replaceEphemeral posts an ephemeral that replaces the original", async () => {
    const body = captureBody();
    await replaceEphemeral("https://hooks.slack.test/x", "done", [
      { type: "section", text: { type: "mrkdwn", text: "done" } },
    ]);
    expect(body()).toMatchObject({ response_type: "ephemeral", replace_original: true, text: "done" });
    expect(body().blocks).toHaveLength(1);
  });
});

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

  it("replaceEphemeral fails soft too, tagged with its own action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(replaceEphemeral("https://hooks.slack.test/x", "hi")).resolves.toBeUndefined();
    expect(warnLines().join("\n")).toContain("slack.response_url.not_ok action=replaceEphemeral status=500");
  });
});
