import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostKeyResolver, parseZoomMeetingId } from "../src/zoom/host-key";
import { installFetchRecorder, ZOOM_HOST_KEY } from "./helpers/fetch-recorder";

afterEach(() => vi.unstubAllGlobals());

describe("parseZoomMeetingId", () => {
  it("reads the id from /j/<id>?pwd=… on any Zoom subdomain", () => {
    expect(parseZoomMeetingId("https://us02web.zoom.us/j/81323022832?pwd=abc")).toBe("81323022832");
    expect(parseZoomMeetingId("https://zoom.us/j/123456789")).toBe("123456789");
    expect(parseZoomMeetingId("https://virtualcoffee.zoom.us/j/1234567890/")).toBe("1234567890");
  });

  it("returns null for non-Zoom urls, free-text locations, and non-meeting Zoom paths", () => {
    expect(parseZoomMeetingId("https://meet.google.com/abc-defg-hij")).toBeNull();
    expect(parseZoomMeetingId("The VC Lounge")).toBeNull();
    expect(parseZoomMeetingId("https://zoom.us/w/personal-1")).toBeNull();
    expect(parseZoomMeetingId("https://zoom.us/j/12")).toBeNull();
  });
});

describe("createHostKeyResolver", () => {
  it("chains meeting → host_id → host_key with a bearer token", async () => {
    const rec = installFetchRecorder({ zoomHostKey: "654321" });
    const resolve = createHostKeyResolver(env);

    await expect(resolve("81323022832")).resolves.toBe("654321");

    const meeting = rec.callsTo("api.zoom.us/v2/meetings/81323022832");
    expect(meeting).toHaveLength(1);
    expect(meeting[0]!.method).toBe("GET");
    expect(rec.callsTo("api.zoom.us/v2/users/HOST1")).toHaveLength(1);
    expect(rec.callsTo("zoom.us/oauth/token")).toHaveLength(1);
  });

  it("caches per run: one token + one user GET for two meetings sharing a host", async () => {
    const rec = installFetchRecorder();
    const resolve = createHostKeyResolver(env);

    const [a, b, again] = await Promise.all([resolve("111111111"), resolve("222222222"), resolve("111111111")]);
    expect([a, b, again]).toEqual([ZOOM_HOST_KEY, ZOOM_HOST_KEY, ZOOM_HOST_KEY]);

    expect(rec.callsTo("zoom.us/oauth/token")).toHaveLength(1);
    expect(rec.callsTo("api.zoom.us/v2/meetings/")).toHaveLength(2);
    expect(rec.callsTo("api.zoom.us/v2/users/")).toHaveLength(1);
  });

  it("rejects on a Zoom error and on a response without the field", async () => {
    const rec = installFetchRecorder();
    rec.respondWith((call) =>
      call.url.includes("/v2/users/") ? new Response("nope", { status: 404 }) : undefined,
    );
    await expect(createHostKeyResolver(env)("111111111")).rejects.toThrow("Zoom get-user failed: 404");

    rec.respondWith((call) => (call.url.includes("/v2/meetings/") ? Response.json({}) : undefined));
    await expect(createHostKeyResolver(env)("111111111")).rejects.toThrow("no host_id");
  });
});
