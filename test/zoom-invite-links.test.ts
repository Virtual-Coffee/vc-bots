import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { log, setLogLevel } from "../src/log";
import { createInviteLink, createZoomInviteLinkPort } from "../src/zoom/invite-links";
import { installFetchRecorder, type FetchRecorder } from "./helpers/fetch-recorder";

/**
 * The Zoom invite-link adapter: what `createInviteLink` puts on the wire and in the logs, and
 * `createZoomInviteLinkPort` (S2S token + invite link) as the DO sees it.
 */

const env = {
  ZOOM_MEETING_ID: "4669259563",
  ZOOM_S2S_CLIENT_ID: "cid",
  ZOOM_S2S_CLIENT_SECRET: "secret",
  ZOOM_S2S_ACCOUNT_ID: "acc",
} as Env;

/** In-memory storage satisfying the TokenCacheStorage shape. */
function memStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => map.get(k) as T | undefined,
    put: async <T>(k: string, v: T) => void map.set(k, v),
  };
}

describe("createZoomInviteLinkPort", () => {
  let fetched: FetchRecorder;

  beforeEach(() => {
    fetched = installFetchRecorder({ zoomJoinUrl: "https://zoom.us/w/personal-1" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mints against the configured meeting and resolves to the personal join url", async () => {
    const port = createZoomInviteLinkPort(env, memStorage());

    expect(await port.mint("Xavier")).toEqual({ joinUrl: "https://zoom.us/w/personal-1" });

    const req = fetched.callsTo("api.zoom.us/v2/meetings/").at(-1)!;
    expect(req.url).toContain(`/meetings/${env.ZOOM_MEETING_ID}/invite_links`);
  });

  it("sends only the attendee name to Zoom — no email or registration fields", async () => {
    await createZoomInviteLinkPort(env, memStorage()).mint("Ada Lovelace");

    const req = fetched.callsTo("api.zoom.us/v2/meetings/").at(-1)!;
    expect(req.url).toContain("/invite_links");
    const sent = JSON.parse(req.body);
    expect(sent.attendees).toEqual([{ name: "Ada Lovelace" }]);
    expect(sent.email).toBeUndefined();
    expect(sent.first_name).toBeUndefined();
    expect(typeof sent.ttl).toBe("number");
  });

  it("reuses the cached S2S token across mints", async () => {
    const port = createZoomInviteLinkPort(env, memStorage());
    await port.mint("Ada");
    await port.mint("Bob");

    expect(fetched.callsTo("zoom.us/oauth/token")).toHaveLength(1);
    expect(fetched.callsTo("api.zoom.us/v2/meetings/")).toHaveLength(2);
  });
});

describe("createInviteLink step logs", () => {
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
