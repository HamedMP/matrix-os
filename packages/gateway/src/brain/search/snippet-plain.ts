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
/** A rule is marks and spaces only (3+ marks, isRule counts them); no two space repeats overlap, so it stays linear. */
const RULE_MARKS = /^ {0,3}[-*_][-*_ \t]*$/;
const UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
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

/** A thematic break (3+ of - * _ among spaces) or a setext underline (= or - run), up to 3 spaces in. */
function isRule(line: string): boolean {
  if (UNDERLINE.test(line)) return true;
  if (!RULE_MARKS.test(line)) return false;
  let marks = 0;
  for (let at = 0; at < line.length && marks < 3; at += 1) {
    if (line[at] === "-" || line[at] === "*" || line[at] === "_") marks += 1;
  }
  return marks >= 3;
}

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

interface Scan {
  readonly pieces: Piece[];
  /** Past the end of an HTML comment that runs on after this line, else -1. */
  readonly resume: number;
}

/** One construct starting at `at`: its pieces and end, or null for plain text. */
function construct(
  ctx: Context, at: number, to: number, pipes: boolean, depth: number, code: CodeSpans,
  pairs: ReadonlyMap<number, number>,
): { readonly pieces: Piece[]; readonly end: number } | null {
  const { source } = ctx;
  const char = source[at]!;
  const span = code.get(at);
  if (span !== undefined) return { pieces: [{ kind: "keep", from: span[0], to: span[1] }], end: span[2] };
  if (char === "\\") {
    // A backslash that ends a line is a line break.
    if (at + 1 === to && (source[to] === "\n" || source[to] === "\r")) return { pieces: [], end: to };
    return at + 1 < to && isAsciiPunctuation(source.charCodeAt(at + 1))
      ? { pieces: [{ kind: "keep", from: at + 1, to: at + 2 }], end: at + 2 } : null;
  }
  if (char === "|") return pipes ? { pieces: [{ kind: "put", text: " ", at }], end: at + 1 } : null;
  if (char === "&") {
    const match = stickyMatch(ENTITY, source, at, to);
    const text = match === null ? null : entityText(match);
    return match === null || text === null ? null : { pieces: [{ kind: "put", text, at }], end: at + match[0].length };
  }
  if (char === "<") {
    const link = stickyMatch(AUTOLINK, source, at, to);
    if (link !== null) {
      return { pieces: [{ kind: "keep", from: at + 1, to: at + link[0].length - 1 }], end: at + link[0].length };
    }
    const tag = stickyMatch(HTML_TAG, source, at, to);
    const name = tag?.[1]!.toLowerCase() ?? "";
    if (tag === null || !(BLOCK_TAGS.has(name) || INLINE_TAGS.has(name))) return null;
    return { pieces: BLOCK_TAGS.has(name) ? [{ kind: "put", text: " ", at }] : [], end: at + tag[0].length };
  }
  if (char === "[" || (char === "!" && source[at + 1] === "[")) {
    const open = char === "[" ? at : at + 1;
    const end = depth < LINK_DEPTH_MAX ? linkEnd(ctx, open, to, pairs) : -1;
    return end === -1 ? null : { pieces: scanInline(ctx, open + 1, pairs.get(open)!, false, depth + 1).pieces, end };
  }
  return null;
}

/** Inline markup of [from, to): code spans, escapes, links, autolinks, HTML, entities, emphasis, table pipes. */
function scanInline(ctx: Context, from: number, to: number, pipes: boolean, depth: number): Scan {
  const { source } = ctx;
  const code = codeSpans(source, from, to);
  const pairs = bracketPairs(source, from, to, code);
  const pieces: Piece[] = [];
  let kept = from;
  const cut = (at: number, resume: number) => {
    if (at > kept) pieces.push({ kind: "keep", from: kept, to: at });
    kept = resume;
  };
  for (let at = from; at < to;) {
    const char = source[at]!;
    if (char === "<" && depth === 0 && source.startsWith("<!--", at)) {
      const close = source.indexOf("-->", at + 2);
      const end = close === -1 ? source.length : close + 3;
      cut(at, end);
      if (end > to) {
        pairDelimiters(pieces);
        return { pieces, resume: end };
      }
      at = end;
      continue;
    }
    const made = construct(ctx, at, to, pipes, depth, code, pairs);
    if (made !== null) {
      cut(at, made.end);
      pieces.push(...made.pieces);
      at = made.end;
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~" && char !== "`") {
      at += 1;
      continue;
    }
    let end = at + 1;
    while (end < to && source[end] === char) end += 1;
    const sides = char === "`" || (char === "~" && end - at !== 2) ? null : flanking(source, at, end, char);
    if (sides !== null && (sides.canOpen || sides.canClose)) {
      cut(at, end);
      pieces.push({ kind: "delimiter", char, from: at, to: end, ...sides });
    }
    at = end;
  }
  cut(to, to);
  pairDelimiters(pieces);
  return { pieces, resume: -1 };
}

/** The content end of an ATX heading line: before a closing run of hashes that follows a space. */
function headingEnd(source: string, from: number, to: number): number {
  let end = to;
  while (end > from && (source[end - 1] === " " || source[end - 1] === "\t")) end -= 1;
  let hashes = end;
  while (hashes > from && source[hashes - 1] === "#") hashes -= 1;
  if (hashes === end || (hashes > from && source[hashes - 1] !== " " && source[hashes - 1] !== "\t")) return end;
  return hashes;
}

/** Stored text with its markup dropped and whitespace collapsed, with the stored index of every unit. */
export function brainPlainText(source: string): BrainPlainText {
  const ctx: Context = { source, labels: definitionLabels(source) };
  const parts: string[] = [];
  const at: number[] = [];
  const emit = (pieces: readonly Piece[]) => {
    for (const piece of pieces) {
      if (piece.kind === "put") {
        parts.push(piece.text);
        for (let unit = 0; unit < piece.text.length; unit += 1) at.push(piece.at);
      } else if (piece.to > piece.from) {
        parts.push(source.slice(piece.from, piece.to));
        for (let index = piece.from; index < piece.to; index += 1) at.push(index);
      }
    }
  };
  let fence: string | null = null;
  let skipUntil = -1;
  const inline = (from: number, to: number, pipes: boolean) => {
    const scan = scanInline(ctx, from, to, pipes, 0);
    emit(scan.pieces);
    if (scan.resume !== -1) skipUntil = scan.resume;
  };
  for (let start = 0; start <= source.length;) {
    const newline = source.indexOf("\n", start);
    const lineEnd = newline === -1 ? source.length : newline;
    const end = lineEnd > start && source[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    if (skipUntil > start) {
      // Inside an HTML comment: only the text after its end is read, as inline text.
      if (skipUntil <= end) {
        const from = skipUntil;
        skipUntil = -1;
        inline(from, end, false);
      }
    } else if (fence !== null) {
      const close = FENCE_CLOSE.exec(source.slice(start, end));
      if (close !== null && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = null;
      else emit([{ kind: "keep", from: start, to: end }]);
    } else {
      const from = start + (QUOTE.exec(source.slice(start, end))?.[0].length ?? 0);
      const rest = source.slice(from, end);
      const open = FENCE_OPEN.exec(rest);
      if (open !== null && !(open[1]![0] === "`" && rest.includes("`", open[0].length))) fence = open[1]!;
      else if (!(isRule(rest) || LINK_DEFINITION.test(rest)
        || (TABLE_RULE.test(rest) && rest.includes("|") && rest.includes("-")))) {
        const heading = HEADING.exec(rest);
        const content = from + ((heading ?? BULLET.exec(rest))?.[0].length ?? 0);
        inline(content, heading === null ? end : headingEnd(source, content, end), rest.trimStart().startsWith("|"));
      }
    }
    if (newline === -1) break;
    emit([{ kind: "put", text: "\n", at: newline }]);
    start = newline + 1;
  }
  return collapse(parts.join(""), at, source.length);
}

/** Runs of whitespace become one space (at its first unit) and the ends are trimmed. */
function collapse(text: string, at: readonly number[], sourceLength: number): BrainPlainText {
  const parts: string[] = [];
  const sources: number[] = [];
  let previousEnd = -1;
  for (const word of text.matchAll(/\S+/g)) {
    if (previousEnd !== -1) {
      parts.push(" ");
      sources.push(at[previousEnd]!);
    }
    parts.push(word[0]);
    for (let index = word.index; index < word.index + word[0].length; index += 1) sources.push(at[index]!);
    previousEnd = word.index + word[0].length;
  }
  sources.push(sourceLength);
  return { text: parts.join(""), sources: Int32Array.from(sources) };
}

/** The first plain index whose stored index is at or after `sourceIndex` (the plain length past the end). */
export function brainPlainIndex(plain: BrainPlainText, sourceIndex: number): number {
  let [low, high] = [0, plain.text.length];
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (plain.sources[middle]! < sourceIndex) low = middle + 1;
    else high = middle;
  }
  return low;
}
