import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLogLevel } from "../src/log";
import { deleteOriginal, replaceEphemeral, respondEphemeral } from "../src/slack/response";
import { installFetchRecorder } from "./helpers/fetch-recorder";

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

/** Record `fetch` (answered 200) and hand back the JSON body of the one call it received. */
function captureBody(): () => Record<string, unknown> {
  const recorder = installFetchRecorder({ respond: () => new Response("ok", { status: 200 }) });
  return () => {
    expect(recorder.calls).toHaveLength(1);
    return JSON.parse(recorder.calls[0]!.body) as Record<string, unknown>;
  };
}

/** Every `fetch` answers `status` — the non-2xx path of the helpers. */
function answerWith(status: number): void {
  installFetchRecorder({ respond: () => new Response("nope", { status }) });
}

describe("response_url helpers pin their guardrails", () => {
  // These two fields are the whole reason the helpers exist (ADR 0004): `response_type` keeps a
  // reply private, and `replace_original` decides whether the "original" — for the channel
  // button, the shared room message — gets overwritten.
  it("respondEphemeral posts a new ephemeral (replace_original: false)", async () => {
    const body = captureBody();
    await respondEphemeral("https://hooks.slack.test/x", "hi");
    expect(body()).toMatchObject({
      response_type: "ephemeral",
      replace_original: false,
      text: "hi",
    });
  });

  it("replaceEphemeral posts an ephemeral that replaces the original", async () => {
    const body = captureBody();
    await replaceEphemeral("https://hooks.slack.test/x", "done", [
      { type: "section", text: { type: "mrkdwn", text: "done" } },
    ]);
    expect(body()).toMatchObject({
      response_type: "ephemeral",
      replace_original: true,
      text: "done",
    });
    expect(body().blocks).toHaveLength(1);
  });
});

describe("response_url helpers fail soft", () => {
  it("logs (does not throw) when the response_url fetch rejects", async () => {
    installFetchRecorder({
      respond: () => {
        throw new Error("network down");
      },
    });

    await expect(respondEphemeral("https://hooks.slack.test/x", "hi")).resolves.toBeUndefined();
    expect(warnLines().join("\n")).toContain("slack.response_url.error action=respondEphemeral");
  });

  it("logs (does not throw) when Slack returns a non-2xx", async () => {
    answerWith(500);

    await expect(deleteOriginal("https://hooks.slack.test/x")).resolves.toBeUndefined();
    expect(warnLines().join("\n")).toContain(
      "slack.response_url.not_ok action=deleteOriginal status=500",
    );
  });

  it("replaceEphemeral fails soft too, tagged with its own action", async () => {
    answerWith(500);

    await expect(replaceEphemeral("https://hooks.slack.test/x", "hi")).resolves.toBeUndefined();
    expect(warnLines().join("\n")).toContain(
      "slack.response_url.not_ok action=replaceEphemeral status=500",
    );
  });
});
