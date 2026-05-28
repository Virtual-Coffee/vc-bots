import { describe, expect, it } from "vitest";
import { htmlToMrkdwn } from "../src/bots/reminders/html-to-mrkdwn";

describe("htmlToMrkdwn", () => {
  it("converts bold, italic, and code", () => {
    expect(htmlToMrkdwn("<strong>a</strong> <em>b</em> <code>c</code>")).toBe("*a* _b_ `c`");
  });

  it("converts links to Slack link syntax", () => {
    expect(htmlToMrkdwn('<a href="https://x.io">click</a>')).toBe("<https://x.io|click>");
  });

  it("turns paragraphs and <br> into newlines", () => {
    expect(htmlToMrkdwn("<p>one</p><p>two<br>three</p>")).toBe("one\ntwo\nthree");
  });

  it("renders list items as bullets", () => {
    expect(htmlToMrkdwn("<ul><li>x</li><li>y</li></ul>")).toBe("• x\n• y");
  });

  it("decodes HTML entities", () => {
    expect(htmlToMrkdwn("Tom &amp; Jerry &mdash; 3 &lt; 5")).toBe("Tom & Jerry — 3 < 5");
  });

  it("strips unknown tags", () => {
    expect(htmlToMrkdwn('<span class="x">hi</span>')).toBe("hi");
  });
});
