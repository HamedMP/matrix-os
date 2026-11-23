/**
 * Reads mail HTML as plain text, for list snippets, for quoting in a
 * plain-text reply and for handing a message to the agent. The mail is parsed
 * into an inert document; nothing from it is ever inserted anywhere.
 */
import { cleanLabel, isHtmlElement, parseDocument, stripInvisible, TEXT_NODE, textOutside } from "./dom";
import { isTrackingPixel } from "./images";
import { findQuote, type QuoteMatch } from "./quotes";
import { MAX_HTML_CHARS } from "./sanitize";
import { safeLinkUrl } from "./url-policy";

export interface HtmlToTextOptions {
  /** Cut the result to this many characters, ending in an ellipsis. */
  maxLength?: number;
  /** Write a link's address after its text, as `text (address)`. Default false. */
  links?: boolean;
  /** Write an image's description, as `[description]`. Default false. */
  images?: boolean;
  /** `keep` (default) prefixes quoted text with `>`; `omit` leaves the quoted trail of a reply out. */
  quotes?: "keep" | "omit";
}

const MAX_DEPTH = 200;
const MAX_QUOTE_DEPTH = 8;

const SKIPPED: ReadonlySet<string> = new Set([
  "script", "style", "head", "title", "template", "noscript", "noembed", "noframes", "svg", "math", "canvas", "audio", "video",
  "iframe", "frame", "frameset", "object", "embed", "applet", "textarea", "select", "button", "input", "datalist", "option", "map",
]);
/** Blocks set apart by an empty line. */
const PARAGRAPHS: ReadonlySet<string> = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "table", "blockquote", "pre", "hr", "figure"]);
/** Blocks that start on a new line. */
const LINES: ReadonlySet<string> = new Set([
  "div", "li", "tr", "dt", "dd", "section", "article", "header", "footer", "aside", "nav", "main", "address", "center",
  "figcaption", "caption", "thead", "tbody", "tfoot", "form", "fieldset", "details", "summary",
]);
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|(?:^|[;\s])(?:font-size|max-height|opacity)\s*:\s*0(?:px|pt|em|%)?\s*(?:;|!|$)/i;

/** Collects text with the line structure of the blocks it came from. */
class TextBuilder {
  private readonly lines: string[] = [""];
  /** Line breaks owed before the next text. */
  private pending = 0;
  private started = false;

  private get current(): string {
    return this.lines[this.lines.length - 1];
  }

  private set current(value: string) {
    this.lines[this.lines.length - 1] = value;
  }

  private flush(): void {
    if (this.started) for (let count = 0; count < this.pending; count += 1) this.lines.push("");
    this.pending = 0;
  }

  /** Asks for at least `count` line breaks before the next text. */
  break(count: number): void {
    this.pending = Math.max(this.pending, count);
  }

  /** Adds flowing text: whitespace is collapsed and never starts a line. */
  text(value: string): void {
    const collapsed = stripInvisible(value).replace(/[\s\u00A0]+/g, " ");
    if (collapsed === "" || (collapsed === " " && (this.pending > 0 || this.current === "" || this.current.endsWith(" ")))) return;
    this.flush();
    this.started = true;
    this.current += this.current === "" || this.current.endsWith(" ") ? collapsed.replace(/^ /, "") : collapsed;
  }

  /** Adds text exactly as written, keeping its own line breaks. */
  raw(value: string): void {
    const parts = stripInvisible(value).split(/\r\n|\r|\n/);
    this.flush();
    this.started = true;
    parts.forEach((part, index) => {
      if (index > 0) this.lines.push("");
      this.current += part;
    });
  }

  /** A hard line break (`<br>`). */
  newline(): void {
    if (!this.started) return;
    this.flush();
    this.lines.push("");
  }

  toString(): string {
    return this.lines.map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  }
}

interface WalkState {
  /** Blockquotes currently open; prefixing stops at MAX_QUOTE_DEPTH so deep nesting cannot multiply the work. */
  quoteDepth: number;
  options: HtmlToTextOptions;
  quote: QuoteMatch | null;
  stopped: boolean;
}

function isHidden(element: Element): boolean {
  return element.hasAttribute("hidden") || HIDDEN_STYLE.test(element.getAttribute("style") ?? "");
}

function walkChildren(parent: Node, out: TextBuilder, state: WalkState, depth: number, pre: boolean): void {
  let item = 0;
  for (let child = parent.firstChild; child && !state.stopped; child = child.nextSibling) {
    if (state.quote && child === state.quote.start) {
      if (state.quote.kind === "trail") state.stopped = true;
      continue;
    }
    if (child.nodeType === TEXT_NODE) {
      if (pre) out.raw((child as Text).data);
      else out.text((child as Text).data);
      continue;
    }
    if (!isHtmlElement(child) || SKIPPED.has(child.localName) || isHidden(child)) continue;
    const tag = child.localName;
    if (tag === "br") out.newline();
    else if (tag === "img") {
      const alt = state.options.images && !isTrackingPixel(child) ? cleanLabel(child.getAttribute("alt"), 200) : "";
      if (alt) out.text(` [${alt}] `);
    } else if (depth >= MAX_DEPTH) out.text(textOutside(child, SKIPPED));
    else if (tag === "blockquote" && state.quoteDepth < MAX_QUOTE_DEPTH) {
      const inner = new TextBuilder();
      state.quoteDepth += 1;
      walkChildren(child, inner, state, depth + 1, false);
      state.quoteDepth -= 1;
      const quoted = inner.toString();
      out.break(2);
      if (quoted) out.raw(quoted.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n"));
      out.break(2);
    } else {
      const gap = PARAGRAPHS.has(tag) ? 2 : LINES.has(tag) ? 1 : 0;
      if (gap) out.break(gap);
      if (tag === "li") {
        item += 1;
        const list = isHtmlElement(parent) && parent.localName === "ol" ? parent : null;
        const start = Number.parseInt(list?.getAttribute("start") ?? "1", 10);
        out.text(list ? `${(Number.isFinite(start) ? start : 1) + item - 1}. ` : "- ");
      } else if ((tag === "td" || tag === "th") && child.previousElementSibling) out.text(" ");
      walkChildren(child, out, state, depth + 1, pre || tag === "pre");
      if (tag === "a" && state.options.links) {
        const href = safeLinkUrl(child.getAttribute("href"));
        const shown = (child.textContent ?? "").trim();
        const address = href?.replace(/^mailto:/, "") ?? "";
        if (href && shown && shown !== address && shown !== href && `${shown}/` !== href) out.text(` (${href})`);
      }
      if (gap) out.break(gap);
    }
  }
}

/** The readable text of a mail's HTML body. */
export function htmlToText(html: string, options: HtmlToTextOptions = {}): string {
  if (typeof html !== "string" || html.trim() === "") return "";
  const source = parseDocument(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html);
  const body = source.body && source.body.localName === "body" ? source.body : null;
  if (!body) return "";
  const out = new TextBuilder();
  walkChildren(body, out, { quoteDepth: 0, options, quote: options.quotes === "omit" ? findQuote(body) : null, stopped: false }, 0, false);
  const text = out.toString();
  const max = options.maxLength;
  if (max === undefined || text.length <= max) return text;
  return max <= 1 ? "…".slice(0, Math.max(0, max)) : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** One line of text for a message list: the start of the mail without its quoted trail. */
export function snippetFromHtml(html: string, maxLength = 160): string {
  const line = htmlToText(html, { quotes: "omit" }).replace(/\s+/g, " ").trim();
  return line.length <= maxLength ? line : `${line.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
