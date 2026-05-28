import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, setLogLevel } from "../src/log";
import { addMeetingRegistrant } from "../src/zoom/registrants";

let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setLogLevel("debug");
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ registrant_id: "reg-1", join_url: "https://zoom.us/w/SECRET-TOKEN-123" })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLogLevel("warn");
});

function debugLines(): string[] {
  return debugSpy.mock.calls.map((c: unknown[]) => String(c[0]));
}

describe("addMeetingRegistrant step logs", () => {
  it("logs create then created at debug, with ids only — never the token-bearing join_url", async () => {
    await addMeetingRegistrant("zoom-access-token", "4669259563", {
      email: "ada@example.com",
      firstName: "Ada",
    });

    const lines = debugLines();
    expect(lines).toContainEqual("[DEBUG] zoom.registrant.create meeting=4669259563 email=ada@example.com");
    expect(lines).toContainEqual("[DEBUG] zoom.registrant.created meeting=4669259563 registrant=reg-1");

    const all = lines.join("\n");
    expect(all).not.toContain("SECRET-TOKEN-123"); // no join_url
    expect(all).not.toContain("zoom-access-token"); // no access token
  });

  it("emits nothing below the threshold when level is info", async () => {
    setLogLevel("info");
    log.debug("should.not.appear");
    await addMeetingRegistrant("t", "1", { email: "x@y.z", firstName: "X" });
    expect(debugLines()).toHaveLength(0);
  });
});
