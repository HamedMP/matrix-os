/**
 * Finds the quoted trail of a reply: the earlier messages a mail client
 * appends below the new text. Only a trailing quote is reported. A forward, an
 * interleaved reply and a message that is nothing but a quote are left alone,
 * because collapsing them would hide what the message is about.
 */
import { isBlank, isHtmlElement, TEXT_NODE } from "./dom";

export interface QuoteMatch {
  /** First node of the quoted trail. */
  start: Node;
  /** `container`: only `start` and its content. `trail`: `start` and everything after it in the document. */
  kind: "container" | "trail";
}

const MAX_ATTRIBUTION_CHARS = 320;
const MAX_CANDIDATES = 40;
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

const REPLY_ATTRIBUTIONS: readonly RegExp[] = [
  /^On\s.{4,}\swrote:$/i,
  /^Am\s.{4,}\sschrieb\s.{1,120}:$/i,
  /^Le\s.{4,}\sa écrit\s?:$/i,
  /^El\s.{4,}\sescribió:$/i,
  /^Il\s.{4,}\sha scritto:$/i,
  /^Den\s.{4,}\sskrev\s.{1,120}:$/i,
  /^Op\s.{4,}\sschreef\s.{1,120}:$/i,
];
const SEPARATORS: readonly RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}$/i,
  /^_{20,}$/,
];
const FORWARD_MARKERS: readonly RegExp[] = [
  /^-{2,}\s*(?:Forwarded message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Messaggio inoltrato|Vidarebefordrat meddelande)/i,
  /^Begin forwarded message:/i,
  /\bSubject:\s*(?:fwd?|wg|tr|rv)\s*:/i,
];
const HEADER_BLOCK = /^(?:From|Von|De|Da|Från|Van):\s/i;
const HEADER_BLOCK_DATE = /(?:Sent|Date|Gesendet|Envoyé|Enviado|Inviato|Skickat|Datum|Verzonden):/i;

const CONTAINER_SELECTOR = "div.gmail_quote, blockquote.gmail_quote, blockquote[type=cite], div.yahoo_quoted, div.protonmail_quote, blockquote.protonmail_quote, blockquote.tutanota_quote, #mail-editor-reference-message-container";
const TRAIL_SELECTOR = "div.moz-cite-prefix, #appendonsend, #divRplyFwdMsg, div.OutlookMessageHeader";
const SKIPPED_SUBTREES: ReadonlySet<string> = new Set(["script", "style", "title", "template", "head"]);

function oneLine(text: string): string {
  return text.replace(/^(?:\s*>)+/, "").replace(/\s+/g, " ").trim();
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** True for the line a mail client writes above a quoted reply ("On ... wrote:"). */
export function isReplyAttribution(line: string): boolean {
  const text = oneLine(line);
  return text.length > 0 && text.length <= MAX_ATTRIBUTION_CHARS && matchesAny(REPLY_ATTRIBUTIONS, text);
}

/** True for a reply attribution or a separator such as "-----Original Message-----". */
export function isAttributionLine(line: string): boolean {
  const text = oneLine(line);
  return isReplyAttribution(line) || (text.length > 0 && text.length <= MAX_ATTRIBUTION_CHARS && matchesAny(SEPARATORS, text));
}

/** True when quoted text starts like a forwarded message. */
export function isForwardMarker(text: string): boolean {
  const start = text.trimStart().slice(0, 600);
  return matchesAny(FORWARD_MARKERS, start);
}

interface Surroundings {
  /** Visible content before the quote. */
  before: boolean;
  /** Visible content after a `container` quote. */
  after: boolean;
  /** The first characters of the quoted text. */
  quoted: string;
}

/** Walks the body in document order and sorts what it sees into before, inside and after the candidate. */
function surroundings(body: Element, candidate: QuoteMatch): Surroundings {
  const result: Surroundings = { before: false, after: false, quoted: "" };
  let phase: "before" | "inside" | "after" = "before";
  const stack: Array<{ node: Node; leave?: boolean }> = [{ node: body }];
  while (stack.length > 0) {
    const entry = stack.pop() as { node: Node; leave?: boolean };
    if (entry.leave) {
      if (candidate.kind === "container") phase = "after";
      continue;
    }
    const node = entry.node;
    if (node === candidate.start) {
      phase = "inside";
      stack.push({ node, leave: true });
    }
    if (node.nodeType === TEXT_NODE) {
      const text = (node as Text).data;
      if (phase === "inside") {
        if (result.quoted.length < 600) result.quoted += text;
      } else if (!isBlank(text)) result[phase] = true;
      continue;
    }
    if (!isHtmlElement(node) || SKIPPED_SUBTREES.has(node.localName)) continue;
    if (node.localName === "img" && phase !== "inside") result[phase] = true;
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child });
  }
  return result;
}

function previousMeaningfulSibling(node: Node): Node | null {
  let previous = node.previousSibling;
  for (let steps = 0; previous && steps < 6; steps += 1, previous = previous.previousSibling) {
    if (previous.nodeType === TEXT_NODE) {
      if (!isBlank((previous as Text).data)) return previous;
    } else if (isHtmlElement(previous)) {
      if (previous.localName !== "br") return previous;
    }
  }
  return null;
}

function candidates(body: Element): QuoteMatch[] {
  const found: QuoteMatch[] = [];
  const seen = new Set<Node>();
  const add = (start: Node, kind: QuoteMatch["kind"]) => {
    if (found.length >= MAX_CANDIDATES || seen.has(start)) return;
    seen.add(start);
    found.push({ start, kind });
  };
  for (const element of Array.from(body.querySelectorAll(CONTAINER_SELECTOR)).slice(0, MAX_CANDIDATES)) add(element, "container");
  for (const element of Array.from(body.querySelectorAll(TRAIL_SELECTOR)).slice(0, MAX_CANDIDATES)) {
    const previous = element.previousElementSibling;
    add(element.id === "divRplyFwdMsg" && previous?.localName === "hr" ? previous : element, "trail");
  }
  // A header block ("From: ... Sent: ...") under a top border, as some desktop clients write it.
  for (const element of Array.from(body.querySelectorAll('div[style*="border-top"]')).slice(0, MAX_CANDIDATES)) {
    const text = oneLine((element.textContent ?? "").slice(0, 400));
    if (HEADER_BLOCK.test(text) && HEADER_BLOCK_DATE.test(text)) add(element, "trail");
  }
  // An attribution line directly above a blockquote.
  for (const blockquote of Array.from(body.querySelectorAll("blockquote")).slice(0, MAX_CANDIDATES)) {
    const previous = previousMeaningfulSibling(blockquote);
    const text = previous?.textContent ?? "";
    if (previous && text.length <= 2 * MAX_ATTRIBUTION_CHARS && isAttributionLine(text)) add(previous, "trail");
  }
  return found.sort((a, b) => (a.start.compareDocumentPosition(b.start) & FOLLOWING ? -1 : 1));
}

/** The quoted trail of an HTML body, or null when there is none worth collapsing. */
export function findQuote(body: Element | null): QuoteMatch | null {
  if (!body) return null;
  const emptyAbove: Node[] = [];
  for (const candidate of candidates(body)) {
    if (emptyAbove.some((outer) => outer.contains(candidate.start))) continue;
    const around = surroundings(body, candidate);
    if (!around.before) {
      emptyAbove.push(candidate.start);
      continue;
    }
    if (isForwardMarker(around.quoted)) continue;
    if (candidate.kind === "container" && around.after) continue;
    return candidate;
  }
  return null;
}

/**
 * The index of the line where the quoted trail of a plain-text body starts, or
 * -1. The trail runs to the end of the text.
 */
export function findTextQuoteStart(lines: readonly string[]): number {
  const blank = (line: string) => isBlank(line);
  const quoted = (line: string) => /^\s?>/.test(line);
  // onlyQuotes[i]: every non-blank line from i on is quoted, and there is at least one.
  const onlyQuotes: boolean[] = new Array<boolean>(lines.length + 1).fill(false);
  let clean = true;
  let any = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!blank(lines[index])) {
      if (quoted(lines[index])) any = true;
      else clean = false;
    }
    onlyQuotes[index] = clean && any;
  }
  const firstOwn = lines.findIndex((line) => !blank(line) && !quoted(line) && !isAttributionLine(line));
  if (firstOwn < 0) return -1;
  for (let index = firstOwn + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (blank(line)) continue;
    const text = oneLine(line);
    if (matchesAny(SEPARATORS, text)) {
      const ahead = lines.slice(index + 1, index + 8);
      if (isForwardMarker(ahead.join("\n")) || (text.startsWith("_") && !ahead.some((next) => HEADER_BLOCK.test(next.trim())))) continue;
      return index;
    }
    const wrapped = /^On\s/i.test(text) && index + 1 < lines.length && isReplyAttribution(`${line} ${lines[index + 1]}`);
    if (isReplyAttribution(line) || wrapped) {
      const after = index + (isReplyAttribution(line) ? 1 : 2);
      if (onlyQuotes[after]) return index;
      continue;
    }
    if (quoted(line) && onlyQuotes[index]) return index;
  }
  return -1;
}
