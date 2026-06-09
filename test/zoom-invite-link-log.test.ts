import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, setLogLevel } from "../src/log";
import { createInviteLink } from "../src/zoom/invite-links";

let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setLogLevel("debug");
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ attendees: [{ name: "Ada", join_url: "https://zoom.us/w/SECRET-TOKEN-123" }] }),
    ),
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

describe("createInviteLink step logs", () => {
  it("logs create then created at debug, with name only — never the token-bearing join_url", async () => {
    const { joinUrl } = await createInviteLink("zoom-access-token", "4669259563", "Ada");
    expect(joinUrl).toBe("https://zoom.us/w/SECRET-TOKEN-123");

    const lines = debugLines();
    expect(lines).toContainEqual("[DEBUG] zoom.invite_link.create meeting=4669259563 name=Ada");
    expect(lines).toContainEqual("[DEBUG] zoom.invite_link.created meeting=4669259563 name=Ada");

    const all = lines.join("\n");
    expect(all).not.toContain("SECRET-TOKEN-123"); // no join_url
    expect(all).not.toContain("zoom-access-token"); // no access token
  });

  it("emits nothing below the threshold when level is info", async () => {
    setLogLevel("info");
    log.debug("should.not.appear");
    await createInviteLink("t", "1", "X");
    expect(debugLines()).toHaveLength(0);
  });
});
