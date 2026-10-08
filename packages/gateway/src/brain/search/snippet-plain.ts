/**
 * Plain text for snippets: stored text with its markdown markup dropped and whitespace collapsed to single spaces,
 * plus the stored index of every plain unit, so a stored span start maps onto the plain text. Link and image text
 * stay and their URLs go; inline code keeps its text without backticks; fenced code keeps its lines as written;
 * heading hashes, list bullets, task boxes, quote markers, rules, table pipes, link definitions, HTML tags and
 * comments go; escapes and common entities are resolved. Only ASCII markup is dropped, so a surrogate pair is never
 * split, and every step is linear in the text.
 */
import { brainSafeCut } from "./types.js";

export interface BrainPlainText {
  readonly text: string;
  /** The stored index of each plain unit (a collapsed space: its first whitespace), then the stored length. */
  readonly sources: Int32Array;
}

/** Link text inside link text is read this deep; deeper brackets stay as written. */
const LINK_DEPTH_MAX = 4;
/** Longest link destination read as one; a longer one leaves the brackets as written. */
const LINK_DESTINATION_MAX = 2_048;

const QUOTE = /^(?:[ \t]*>[ \t]?)+/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const RULE = /^ {0,3}(?:(?:[-*_][ \t]*){3,}|=+|-+)[ \t]*$/;
const TABLE_RULE = /^[|:\- \t]+$/;
/** An optional link title, then the end of the text. */
const TITLE_END = String.raw`(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$`;
const LINK_DEFINITION = new RegExp(String.raw`^ {0,3}\[(?!\^)([^\]\n]{1,999})\]:[ \t]*\S+` + TITLE_END);
const LINK_DEFINITIONS = new RegExp(LINK_DEFINITION.source, "gm");
const DESTINATION = new RegExp(String.raw`^[ \t]*(?:<[^<>\n]*>|[^\s<]*)` + TITLE_END);
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const BULLET = /^[ \t]*[-*+](?:[ \t]+\[[ xX]\])?(?:[ \t]+|$)/;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/y;
const HTML_TAG = /<\/?([A-Za-z][A-Za-z0-9]*)(?:[ \t][^<>\n]*)?\/?>/y;
const ENTITY = /&(?:#[xX]([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos|nbsp));/y;
const SPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
};
/** HTML tags that end a line of text when rendered; other known tags just go. */
const BLOCK_TAGS = new Set(["address", "article", "aside", "blockquote", "br", "center", "dd", "details", "div",
  "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "img", "li",
  "main", "nav", "ol", "p", "picture", "pre", "section", "source", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul", "video"]);
const INLINE_TAGS = new Set(["a", "abbr", "b", "cite", "code", "del", "em", "i", "ins", "kbd", "mark", "q", "s",
  "samp", "small", "span", "strike", "strong", "sub", "sup", "u", "var"]);

/** A stored range kept as is, a text put in for the unit at `at`, or an emphasis run not yet paired. */
type Piece = { readonly kind: "keep"; readonly from: number; readonly to: number }
  | { readonly kind: "put"; readonly text: string; readonly at: number } | Delimiter;
interface Delimiter {
  readonly kind: "delimiter"; readonly char: string; from: number; to: number;
  readonly canOpen: boolean; readonly canClose: boolean;
}
interface Context { readonly source: string; readonly labels: ReadonlySet<string> }
/** Code spans by opening backtick: [content start, content end, span end]. */
type CodeSpans = Map<number, readonly [number, number, number]>;

const label = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const isAsciiPunctuation = (code: number) => (code >= 33 && code <= 47) || (code >= 58 && code <= 64)
  || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
const pointAt = (source: string, index: number) =>
  (index >= source.length ? " " : String.fromCodePoint(source.codePointAt(index)!));
const pointBefore = (source: string, index: number) =>
  (index <= 0 ? " " : String.fromCodePoint(source.codePointAt(brainSafeCut(source, index - 1))!));

/** A sticky pattern's match at `at` that ends by `to`, else null. */
function stickyMatch(pattern: RegExp, source: string, at: number, to: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  const match = pattern.exec(source);
  return match !== null && at + match[0].length <= to ? match : null;
}

/** The text of a named or numeric entity; null for a code point that is not a character. */
function entityText(match: RegExpExecArray): string | null {
  if (match[3] !== undefined) return NAMED_ENTITIES[match[3]]!;
  const point = match[1] === undefined ? Number.parseInt(match[2]!, 10) : Number.parseInt(match[1], 16);
  return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : null;
}

/** Labels of the link reference definitions, so `[text][label]` reads as a link only when the label exists. */
function definitionLabels(source: string): Set<string> {
  const labels = new Set<string>();
  if (!source.includes("]:")) return labels;
  for (const match of source.matchAll(LINK_DEFINITIONS)) labels.add(label(match[1]!));
  return labels;
}

/** Paired backtick runs in [from, to); a run after a backslash is text. */
function codeSpans(source: string, from: number, to: number): CodeSpans {
  const runs: [number, number][] = [];
  for (let at = from; at < to; at += 1) {
    if (source[at] !== "`") continue;
    let end = at + 1;
    while (end < to && source[end] === "`") end += 1;
    if (source[at - 1] !== "\\") runs.push([at, end]);
    at = end - 1;
  }
  const next = new Array<number>(runs.length).fill(-1);
  const seen = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const size = runs[index]![1] - runs[index]![0];
    next[index] = seen.get(size) ?? -1;
    seen.set(size, index);
  }
  const spans: CodeSpans = new Map();
  for (let index = 0; index < runs.length;) {
    const close = next[index]!;
    if (close === -1) {
      index += 1;
      continue;
    }
    let [start, end] = [runs[index]![1], runs[close]![0]];
    const padded = end - start >= 2 && source[start] === " " && source[end - 1] === " ";
    if (padded && source.slice(start, end).trim() !== "") [start, end] = [start + 1, end - 1];
    spans.set(runs[index]![0], [start, end, runs[close]![1]]);
    index = close + 1;
  }
  return spans;
}

/** Matching [ ] and ( ) outside code spans and escapes, opener index to closer index. */
function bracketPairs(source: string, from: number, to: number, code: CodeSpans): Map<number, number> {
  const pairs = new Map<number, number>();
  const squares: number[] = [];
  const rounds: number[] = [];
  for (let at = from; at < to; at += 1) {
    const span = code.get(at);
    const char = source[at];
    if (span !== undefined) at = span[2] - 1;
    else if (char === "\\") at += 1;
    else if (char === "[") squares.push(at);
    else if (char === "(") rounds.push(at);
    else if (char === "]" || char === ")") {
      const open = (char === "]" ? squares : rounds).pop();
      if (open !== undefined) pairs.set(open, at);
    }
  }
  return pairs;
}

/** The end of the link whose text opens at `open`: inline `(dest "title")`, or a defined `[label]` / `[]`. */
function linkEnd(ctx: Context, open: number, to: number, pairs: ReadonlyMap<number, number>): number {
  const close = pairs.get(open);
  if (close === undefined) return -1;
  const target = pairs.get(close + 1);
  if (target === undefined || target >= to) return -1;
  if (ctx.source[close + 1] === "(") {
    const destination = ctx.source.slice(close + 2, target);
    return destination.length <= LINK_DESTINATION_MAX && DESTINATION.test(destination) ? target + 1 : -1;
  }
  const name = target === close + 2 ? ctx.source.slice(open + 1, close) : ctx.source.slice(close + 2, target);
  return ctx.labels.has(label(name)) ? target + 1 : -1;
}

/** Emphasis rules of CommonMark: whether a run of `*`, `_` or `~` can open or close, from its neighbours. */
function flanking(source: string, start: number, end: number, char: string): { canOpen: boolean; canClose: boolean } {
  const [before, after] = [pointBefore(source, start), pointAt(source, end)];
  const [spaceBefore, spaceAfter] = [SPACE.test(before), SPACE.test(after)];
  const [markBefore, markAfter] = [PUNCTUATION.test(before), PUNCTUATION.test(after)];
  const left = !spaceAfter && (!markAfter || spaceBefore || markBefore);
  const right = !spaceBefore && (!markBefore || spaceAfter || markAfter);
  if (char !== "_") return { canOpen: left, canClose: right };
  return { canOpen: left && (!right || markBefore), canClose: right && (!left || markAfter) };
}

/** Pairs emphasis runs (inner units first, two at a time when both have two) and keeps what stays unpaired. */
function pairDelimiters(pieces: Piece[]): void {
  const openers: Delimiter[] = [];
  const bottom = new Map<string, number>();
  for (const closer of pieces) {
    if (closer.kind !== "delimiter") continue;
    while (closer.canClose && closer.to > closer.from) {
      let index = openers.length - 1;
      const floor = bottom.get(closer.char) ?? 0;
      while (index >= floor && openers[index]!.char !== closer.char) index -= 1;
      if (index < floor) {
        bottom.set(closer.char, openers.length);
        break;
      }
      const opener = openers[index]!;
      const take = opener.to - opener.from >= 2 && closer.to - closer.from >= 2 ? 2 : 1;
      opener.to -= take;
      closer.from += take;
      openers.length = opener.to > opener.from ? index + 1 : index;
      for (const [char, value] of bottom) bottom.set(char, Math.min(value, openers.length));
    }
    if (closer.canOpen && closer.to > closer.from) openers.push(closer);
  }
}
