import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { setLogLevel } from "../src/log";
import { notifyBotLog, reportFailure } from "../src/slack/notify";

const baseEnv = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_BOTLOG_CHANNEL_ID: "C0BATRPD3QC" } as Env;

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setLogLevel("warn");
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLogLevel("warn");
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c: unknown[]) => String(c[0]));
}

describe("notifyBotLog", () => {
  it("posts to the configured channel with the event + fields", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await notifyBotLog(baseEnv, "reminder.run_failed", { cron: "0 12 * * *", error: "boom" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const req = (fetchMock.mock.calls[0] as unknown[])[0] as Request;
    expect(req.url).toContain("chat.postMessage");
    const body = await req.text();
    expect(body).toContain("C0BATRPD3QC"); // posted to the bot-log channel
    expect(body).toContain("reminder.run_failed");
    expect(body).toContain("cron%3D0+12"); // form-encoded `cron=0 12 ...`
  });

  it("no-ops (no fetch) when the channel id is empty", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await notifyBotLog({ ...baseEnv, SLACK_BOTLOG_CHANNEL_ID: "" }, "x.failed", { a: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a post failure and only log.warns (no throw, no re-notify)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(notifyBotLog(baseEnv, "join.failed", { user: "U1" })).resolves.toBeUndefined();
    expect(lines(warnSpy).join("\n")).toContain("botlog.notify_failed event=join.failed");
  });
});

describe("reportFailure", () => {
  it("logs at error and posts to the botlog channel with error= and the extra fields", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await reportFailure(baseEnv, "join.failed", new Error("boom"), { user: "U1" });

    expect(lines(errorSpy).join("\n")).toContain("join.failed user=U1 error=Error: boom");
    expect(fetchMock).toHaveBeenCalledOnce();
    const req = (fetchMock.mock.calls[0] as unknown[])[0] as Request;
    const body = await req.text();
    expect(body).toContain("C0BATRPD3QC");
    expect(body).toContain("join.failed");
    expect(body).toContain("user%3DU1");
    expect(body).toContain("error%3DError%3A+boom");
  });

  it("makes no Slack post when the channel id is empty", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await reportFailure({ ...baseEnv, SLACK_BOTLOG_CHANNEL_ID: "" }, "x.failed", "boom");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a post failure like notifyBotLog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(reportFailure(baseEnv, "join.failed", "boom")).resolves.toBeUndefined();
    expect(lines(warnSpy).join("\n")).toContain("botlog.notify_failed event=join.failed");
  });
});
