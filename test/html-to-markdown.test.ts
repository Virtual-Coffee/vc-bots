import { describe, expect, it } from "vitest";
import { UnsupportedHtmlError, htmlToMarkdown } from "../src/html-to-markdown";

describe("htmlToMarkdown", () => {
  it("returns Markdown untouched (no tags, no entities)", () => {
    const markdown =
      "You want to learn that new tool, but you’re so busy!\n\nDrop into our **sessions** whenever.";
    expect(htmlToMarkdown(markdown)).toBe(markdown);
  });

  it("unwraps a <p> wrapper", () => {
    expect(htmlToMarkdown('<p>Job hunting as a collective. "Hunt with the pack!"</p>')).toBe(
      'Job hunting as a collective. "Hunt with the pack!"',
    );
  });

  it("joins paragraphs with a blank line and turns <br> into a newline", () => {
    expect(htmlToMarkdown("<p>One<br>two</p><p>Three</p>")).toBe("One\ntwo\n\nThree");
  });

  it("decodes named and numeric entities", () => {
    expect(
      htmlToMarkdown("Avi Flombaum &amp; Adam Enbar. It&#39;s great &#x2014; &quot;yes&quot;"),
    ).toBe('Avi Flombaum & Adam Enbar. It\'s great — "yes"');
  });

  it("converts links, bold and italic", () => {
    expect(
      htmlToMarkdown(
        'See <a href="https://virtualcoffee.io">the site</a> for <b>details</b> and <em>more</em>.',
      ),
    ).toBe("See [the site](https://virtualcoffee.io) for **details** and _more_.");
  });

  it("converts lists", () => {
    expect(
      htmlToMarkdown(
        "Bring:<ul><li>questions</li><li>coffee</li></ul>Then:<ol><li>a</li><li>b</li></ol>",
      ),
    ).toBe("Bring:\n- questions\n- coffee\n\nThen:\n1. a\n2. b");
  });

  it("refuses a tag outside the supported set", () => {
    expect(() => htmlToMarkdown("<div>hi</div>")).toThrow(UnsupportedHtmlError);
    expect(() => htmlToMarkdown("<div>hi</div>")).toThrow("unsupported HTML tag <div>");
  });

  it("refuses a link without an href rather than dropping it", () => {
    expect(() => htmlToMarkdown("<a>hi</a>")).toThrow(UnsupportedHtmlError);
  });
});
