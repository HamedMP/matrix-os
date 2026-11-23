/**
 * Shows a plain-text mail body as HTML: every character of the mail stays
 * text, web and mail addresses become links, and `>` quoting becomes nested
 * blockquotes. Nodes are built one by one, never from a markup string.
 */
import { createInertDocument, PLAIN_CLASS } from "./dom";
import { findTextQuoteStart } from "./quotes";
import { emptySanitizedEmail, type SanitizedEmail } from "./sanitize";
import { safeLinkUrl } from "./url-policy";

export interface TextToHtmlOptions {
  /** `collapse` (default) leaves the quoted trail of a reply out; `show` keeps it. */
  quotes?: "collapse" | "show";
}

export const MAX_TEXT_CHARS = 500_000;
const MAX_TEXT_LINES = 20_000;
const MAX_QUOTE_DEPTH = 6;

const LINKABLE = /((?:https?:\/\/|www\.)[^\s<>"'`]+)|([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,251}\.[A-Za-z]{2,24})/gi;

/** Cuts punctuation that ends a sentence, not the address: trailing dots, commas and unbalanced brackets. */
function trimAddress(candidate: string): string {
  let end = candidate.length;
  for (;;) {
    const last = candidate[end - 1];
    if (end > 0 && /[.,;:!?'*]/.test(last)) end -= 1;
    else if (end > 0 && (last === ")" || last === "]" || last === "}")) {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const body = candidate.slice(0, end);
      if (body.split(last).length - 1 <= body.split(open).length - 1) break;
      end -= 1;
    } else break;
  }
  return candidate.slice(0, end);
}

function link(doc: Document, href: string, text: string): HTMLElement {
  const anchor = doc.createElement("a");
  anchor.setAttribute("href", href);
  anchor.setAttribute("target", "_blank");
  anchor.setAttribute("rel", "noopener noreferrer");
  anchor.appendChild(doc.createTextNode(text));
  return anchor;
}

/** Appends `text` to `target`, with addresses turned into links. */
export function appendLinkified(target: Element, text: string, doc: Document): void {
  let at = 0;
  for (const match of text.matchAll(LINKABLE)) {
    const start = match.index ?? 0;
    const shown = match[1] ? trimAddress(match[1]) : match[2];
    const href = match[1] ? safeLinkUrl(/^www\./i.test(shown) ? `https://${shown}` : shown) : safeLinkUrl(`mailto:${shown}`);
    if (!href) continue;
    if (start > at) target.appendChild(doc.createTextNode(text.slice(at, start)));
    target.appendChild(link(doc, href, shown));
    at = start + shown.length;
  }
  if (at < text.length) target.appendChild(doc.createTextNode(text.slice(at)));
}

const isQuoted = (line: string) => /^\s?>/.test(line);

function appendLines(lines: readonly string[], target: Element, doc: Document, depth: number): void {
  let index = 0;
  while (index < lines.length) {
    const quoted = depth < MAX_QUOTE_DEPTH && isQuoted(lines[index]);
    let end = index;
    while (end < lines.length && (depth < MAX_QUOTE_DEPTH && isQuoted(lines[end])) === quoted) end += 1;
    const group = lines.slice(index, end);
    if (quoted) {
      const blockquote = doc.createElement("blockquote");
      appendLines(group.map((line) => line.replace(/^\s?>\s?/, "")), blockquote, doc, depth + 1);
      target.appendChild(blockquote);
    } else {
      group.forEach((line, position) => {
        if (position > 0) target.appendChild(doc.createElement("br"));
        if (line) appendLinkified(target, line, doc);
      });
      // An empty last line needs a break of its own to show as a blank line above the quote that follows.
      if (group[group.length - 1] === "" && end < lines.length) target.appendChild(doc.createElement("br"));
    }
    index = end;
  }
}

/** Renders a plain-text body. The result has the same shape as `sanitizeEmailHtml`'s. */
export function textToHtml(text: string, options: TextToHtmlOptions = {}): SanitizedEmail {
  const result = emptySanitizedEmail();
  if (typeof text !== "string" || text.trim() === "") return result;
  result.truncated = text.length > MAX_TEXT_CHARS;
  let lines = (result.truncated ? text.slice(0, MAX_TEXT_CHARS) : text).replace(/\u0000/g, "").split(/\r\n|\r|\n/);
  if (lines.length > MAX_TEXT_LINES) {
    lines = lines.slice(0, MAX_TEXT_LINES);
    result.truncated = true;
  }
  const quoteStart = findTextQuoteStart(lines);
  result.hasQuote = quoteStart >= 0;
  result.quoteCollapsed = result.hasQuote && (options.quotes ?? "collapse") === "collapse";
  if (result.quoteCollapsed) lines = lines.slice(0, quoteStart);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();

  const doc = createInertDocument();
  const container = doc.createElement("div");
  const block = doc.createElement("div");
  block.setAttribute("class", PLAIN_CLASS);
  appendLines(lines, block, doc, 0);
  container.appendChild(block);
  result.html = container.innerHTML;
  return result;
}

/** Prefixes every line with `> `, as a plain-text reply quotes the message it answers. */
export function quoteText(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}
