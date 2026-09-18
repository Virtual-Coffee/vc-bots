import { describe, expect, it } from "vitest";
import { deriveJoinInfo } from "../src/events";

const ZOOM = "https://us02web.zoom.us/j/81323022832?pwd=abc";

/** The one Join Link rule every source applies (docs/adr/0002); the adapters' own suites cover
 *  how each provider's fields feed it. */
describe("deriveJoinInfo", () => {
  it("none: no Join Link", () => {
    expect(deriveJoinInfo(null, null)).toEqual({ kind: "none" });
    expect(deriveJoinInfo(null, "123")).toEqual({ kind: "none" });
  });

  it("zoom: a Zoom url with a host code carries the meeting id + host key", () => {
    expect(deriveJoinInfo(ZOOM, "123456")).toEqual({
      kind: "zoom",
      url: ZOOM,
      meetingId: "81323022832",
      hostKey: "123456",
    });
  });

  it("invalid (null): a Zoom url without a host code", () => {
    expect(deriveJoinInfo(ZOOM, null)).toBeNull();
  });

  it("url: any other http(s) link, ignoring a stray host code", () => {
    expect(deriveJoinInfo("https://meet.example/x", "999")).toEqual({
      kind: "url",
      url: "https://meet.example/x",
    });
    expect(deriveJoinInfo("HTTPS://meet.example/x", null)).toEqual({
      kind: "url",
      url: "HTTPS://meet.example/x",
    });
  });

  it("place: free text, a scheme-less host, or a non-http(s) scheme", () => {
    expect(deriveJoinInfo("The Library, Room 4", null)).toEqual({
      kind: "place",
      text: "The Library, Room 4",
    });
    expect(deriveJoinInfo("zoom.us/j/81323022832", null)).toEqual({
      kind: "place",
      text: "zoom.us/j/81323022832",
    });
    expect(deriveJoinInfo("ftp://zoom.us/j/81323022832", null)).toEqual({
      kind: "place",
      text: "ftp://zoom.us/j/81323022832",
    });
  });
});
