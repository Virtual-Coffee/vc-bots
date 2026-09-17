/**
 * The HTML → Markdown converter behind `scripts/fix-calendar.ts` (the one-off calendar
 * migration in ADR 0001 §Consequences). Google Calendar's UI stores descriptions as HTML;
 * the bots render Markdown (`docs/adr/0001`). This covers the tag set the calendar actually
 * holds plus a little headroom, and refuses anything else rather than guess.
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

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? match;
  });
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
    .replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<a\b[^>]*href\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");

  // Any tag left is a supported one that appeared without its pair; `<a>` without href, say.
  const leftover = TAG_RE.exec(markdown);
  TAG_RE.lastIndex = 0;
  if (leftover) throw new UnsupportedHtmlError(leftover[1]!.toLowerCase());

  return decodeEntities(markdown)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
