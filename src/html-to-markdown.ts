/**
 * HTML → Markdown for event descriptions. The bots render Markdown (`docs/adr/0001`); this is
 * how HTML from elsewhere gets there: `scripts/fix-calendar.ts` (the one-off calendar migration
 * in ADR 0001 §Consequences) and the interim CMS event source (`src/bots/reminders/sources/cms.ts`,
 * whose descriptions are Craft-rendered HTML). It covers the tag set those actually hold plus a
 * little headroom, and refuses anything else rather than guess.
 *
 * Markdown specials in the prose (`*`, `_`, `#`) are left as they are — none appear in the
 * corpus, and escaping them would change text that is already valid Markdown.
 */

/** Thrown for a tag outside the supported set; the caller reports and skips that event. */
export class UnsupportedHtmlError extends Error {
  readonly tagName: string;
  constructor(tagName: string) {
    super(`unsupported HTML tag <${tagName}>`);
    this.name = "UnsupportedHtmlError";
    this.tagName = tagName;
  }
}

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const SUPPORTED_TAGS = new Set(["p", "br", "a", "b", "strong", "i", "em", "ul", "ol", "li"]);
// Only supported tags can survive the conversion; anything else `<…>`-shaped in the output is an
// angle-bracketed link destination, not a tag.
const LEFTOVER_TAG_RE = new RegExp(`<\\/?(${[...SUPPORTED_TAGS].join("|")})\\b[^>]*>`, "i");

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body] ?? match;
    const hex = body[1] === "x" || body[1] === "X";
    const codePoint = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    // `String.fromCodePoint` throws past U+10FFFF and on a lone surrogate; a bad entity in one
    // description must not fail the whole fetch, so it becomes U+FFFD instead.
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "�";
    return String.fromCodePoint(codePoint);
  });
}

/** `[text](href)`, angle-bracketing the destination when CommonMark would otherwise misread it. */
function markdownLink(text: string, href: string): string {
  return /[\s()]/.test(href) ? `[${text}](<${href}>)` : `[${text}](${href})`;
}

/** Converts the small HTML subset Google Calendar descriptions use into Markdown. */
export function htmlToMarkdown(input: string): string {
  const hasTag = TAG_RE.test(input);
  TAG_RE.lastIndex = 0;
  const hasEntity = ENTITY_RE.test(input);
  ENTITY_RE.lastIndex = 0;
  if (!hasTag && !hasEntity) return input;

  for (const match of input.matchAll(TAG_RE)) {
    const tagName = match[1]!.toLowerCase();
    if (!SUPPORTED_TAGS.has(tagName)) throw new UnsupportedHtmlError(tagName);
  }

  const markdown = input
    .replace(/\r\n?/g, "\n")
    // Blocks first: paragraphs and list items become their own lines.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p\b[^>]*>/gi, "")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, name: string, body: string) => {
      const ordered = name.toLowerCase() === "ol";
      let n = 0;
      const items = body
        .replace(/<li\b[^>]*>/gi, () => (ordered ? `${++n}. ` : "- "))
        .replace(/<\/li>/gi, "\n");
      return `\n${items}\n`;
    })
    // Inline: links, bold, italic.
    .replace(
      /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, dq: string | undefined, sq: string | undefined, text: string) =>
        markdownLink(text, dq ?? sq ?? ""),
    )
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");

  // Any tag left is a supported one that appeared without its pair; `<a>` without href, say.
  const leftover = LEFTOVER_TAG_RE.exec(markdown);
  if (leftover) throw new UnsupportedHtmlError(leftover[1]!.toLowerCase());

  return decodeEntities(markdown)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
