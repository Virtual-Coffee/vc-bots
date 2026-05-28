import { afterEach, describe, expect, it, vi } from "vitest";
import { log, setLogLevel } from "../src/log";

function spyConsole() {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel("warn"); // reset module-global threshold
});

describe("log thresholds", () => {
  it("suppresses below-threshold levels and emits at/above", () => {
    setLogLevel("info");
    const c = spyConsole();
    log.debug("d");
    log.info("i");
    log.warn("w");
    expect(c.debug).not.toHaveBeenCalled();
    expect(c.info).toHaveBeenCalledTimes(1);
    expect(c.warn).toHaveBeenCalledTimes(1);
  });

  it("at error level, only error emits", () => {
    setLogLevel("error");
    const c = spyConsole();
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(c.info).not.toHaveBeenCalled();
    expect(c.warn).not.toHaveBeenCalled();
    expect(c.error).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown levels (threshold unchanged)", () => {
    setLogLevel("info");
    setLogLevel("bogus");
    const c = spyConsole();
    log.info("i");
    expect(c.info).toHaveBeenCalledTimes(1);
  });
});

describe("log formatting", () => {
  it("renders level tag, event, and fields; skips undefined; JSON-encodes objects", () => {
    setLogLevel("debug");
    const c = spyConsole();
    log.error("zoom.webhook", { event: "meeting.started", n: 3, skip: undefined, obj: { a: 1 } });

    const line = c.error.mock.calls[0]?.[0] as string;
    expect(line).toBe('[ERROR] zoom.webhook event=meeting.started n=3 obj={"a":1}');
    expect(line).not.toContain("skip");
  });

  it("emits just the event when there are no fields", () => {
    setLogLevel("info");
    const c = spyConsole();
    log.info("request");
    expect(c.info.mock.calls[0]?.[0]).toBe("[INFO] request");
  });
});
