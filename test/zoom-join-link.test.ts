import { describe, expect, it } from "vitest";
import { parseZoomMeetingId } from "../src/zoom/join-link";

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

  it("rejects lookalike hosts — only zoom.us and its subdomains count", () => {
    expect(parseZoomMeetingId("https://notzoom.us/j/123456789")).toBeNull();
    expect(parseZoomMeetingId("https://zoom.us.evil.com/j/123456789")).toBeNull();
    expect(parseZoomMeetingId("https://evil.com/?u=https://zoom.us/j/123456789")).toBeNull();
  });
});
