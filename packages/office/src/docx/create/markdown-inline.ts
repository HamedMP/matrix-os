/**
 * Inline Markdown: backslash escapes, code spans, links and autolinks,
 * `*`/`_` emphasis and strong emphasis, and `~~` strikethrough. Raw HTML is
 * not interpreted; it stays literal text.
 *
 * Emphasis follows the delimiter-run rules of CommonMark in a simplified,
 * linear form: delimiters are matched with a stack and a per-character
 * lower bound, so hostile input cannot make matching quadratic.
 */

import type { NewRun } from "./model.js";

type Flag = "bold" | "italic" | "strike";

interface Delimiter {
  char: "*" | "_" | "~";
  count: number;
  readonly original: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}

interface Token {
  text: string;
  code?: boolean;
  /** Runs of a link (already parsed), or undefined. */
  link?: NewRun[];
  delimiter?: Delimiter;
}

/** How far a link label or destination is searched for its closing bracket. */
const LINK_SCAN_LIMIT = 2048;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^\s<>]{1,2048})>/i;

const isWhitespace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);
const isPunctuation = (char: string | undefined): boolean => char !== undefined && /[\p{P}\p{S}]/u.test(char);

function delimiterRun(text: string, start: number, char: "*" | "_" | "~", length: number): Delimiter {
  const before = start === 0 ? undefined : text[start - 1];
  const after = text[start + length];
  const left = !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  const right = !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
  if (char === "_") {
    return {
      char,
      count: length,
      original: length,
      canOpen: left && (!right || isPunctuation(before)),
      canClose: right && (!left || isPunctuation(after)),
    };
  }
  return { char, count: length, original: length, canOpen: left, canClose: right };
}

/** Index of the `]` that closes the `[` at `open`, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  const limit = Math.min(text.length, open + LINK_SCAN_LIMIT);
  for (let index = open; index < limit; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return index;
  }
  return -1;
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  const limit = Math.min(text.length, open + LINK_SCAN_LIMIT);
  for (let index = open; index < limit; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
    else if (char === "\n") return -1;
  }
  return -1;
}

function linkDestination(raw: string): string {
  let destination = raw.trim();
  if (destination.startsWith("<")) {
    const end = destination.indexOf(">");
    return end === -1 ? destination : destination.slice(1, end);
  }
  const space = destination.search(/\s/);
  if (space !== -1) destination = destination.slice(0, space);
  return destination.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function tokenize(text: string, allowLinks: boolean): Token[] {
  const tokens: Token[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") tokens.push({ text: literal });
    literal = "";
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === "\\" && index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1] as string)) {
      literal += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (text[index + run] === "`") run++;
      const fence = "`".repeat(run);
      let search = index + run;
      let close = -1;
      while (search < text.length) {
        const found = text.indexOf(fence, search);
        if (found === -1) break;
        let end = found + run;
        while (text[end] === "`") end++;
        if (end - found === run) {
          close = found;
          break;
        }
        search = end;
      }
      if (close === -1) {
        literal += fence;
        index += run;
        continue;
      }
      let content = text.slice(index + run, close).replace(/\n/g, " ");
      if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
        content = content.slice(1, -1);
      }
      flush();
      tokens.push({ text: content, code: true });
      index = close + run;
      continue;
    }
    if (char === "<") {
      const auto = AUTOLINK.exec(text.slice(index, index + 2060));
      if (auto !== null && allowLinks) {
        const href = auto[1] as string;
        flush();
        tokens.push({ text: href, link: [{ text: href, href }] });
        index += auto[0].length;
        continue;
      }
    }
    if (char === "[" && allowLinks) {
      const close = closingBracket(text, index);
      if (close !== -1 && text[close + 1] === "(") {
        const end = closingParen(text, close + 1);
        if (end !== -1) {
          const href = linkDestination(text.slice(close + 2, end));
          const inner = parseInline(text.slice(index + 1, close), false);
          flush();
          tokens.push({ text: "", link: inner.map((run) => (href === "" ? run : { ...run, href })) });
          index = end + 1;
          continue;
        }
      }
    }
    if (char === "*" || char === "_" || char === "~") {
      let run = 1;
      while (text[index + run] === char) run++;
      if (char !== "~" || run === 2) {
        flush();
        tokens.push({ text: char.repeat(run), delimiter: delimiterRun(text, index, char, run) });
        index += run;
        continue;
      }
    }
    literal += char;
    index++;
  }
  flush();
  return tokens;
}

/** Matches delimiters and returns the flag ranges `[from, to)` over token indexes. */
function matchDelimiters(tokens: readonly Token[]): Array<[number, number, Flag]> {
  const ranges: Array<[number, number, Flag]> = [];
  const stack: number[] = [];
  const bottom: Record<string, number> = { "*": 0, _: 0, "~": 0 };
  for (let position = 0; position < tokens.length; position++) {
    const closer = tokens[position]?.delimiter;
    if (closer === undefined) continue;
    while (closer.canClose && closer.count > 0) {
      let found = -1;
      for (let entry = stack.length - 1; entry >= (bottom[closer.char] ?? 0); entry--) {
        const opener = tokens[stack[entry] as number]?.delimiter as Delimiter;
        if (opener.char !== closer.char || opener.count === 0) continue;
        const oddMatch =
          (opener.canClose || closer.canOpen) &&
          (opener.original + closer.original) % 3 === 0 &&
          !(opener.original % 3 === 0 && closer.original % 3 === 0);
        if (closer.char !== "~" && oddMatch) continue;
        found = entry;
        break;
      }
      if (found === -1) {
        bottom[closer.char] = stack.length;
        break;
      }
      const openerIndex = stack[found] as number;
      const opener = tokens[openerIndex]?.delimiter as Delimiter;
      const use = closer.char === "~" ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      const flag: Flag = closer.char === "~" ? "strike" : use === 2 ? "bold" : "italic";
      ranges.push([openerIndex + 1, position, flag]);
      opener.count -= use;
      closer.count -= use;
      stack.length = opener.count === 0 ? found : found + 1;
      for (const key of Object.keys(bottom)) bottom[key] = Math.min(bottom[key] ?? 0, stack.length);
    }
    if (closer.canOpen && closer.count > 0) stack.push(position);
  }
  return ranges;
}

function sameFormat(a: NewRun, b: NewRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.href === b.href;
}

/** Parses the inline content of one block into runs; `\n` in `text` is a line break. */
export function parseInline(text: string, allowLinks = true): NewRun[] {
  const tokens = tokenize(text, allowLinks);
  const flags: Record<Flag, number[]> = {
    bold: new Array<number>(tokens.length + 1).fill(0),
    italic: new Array<number>(tokens.length + 1).fill(0),
    strike: new Array<number>(tokens.length + 1).fill(0),
  };
  for (const [from, to, flag] of matchDelimiters(tokens)) {
    (flags[flag] as number[])[from] += 1;
    (flags[flag] as number[])[to] -= 1;
  }
  const active: Record<Flag, number> = { bold: 0, italic: 0, strike: 0 };
  const runs: NewRun[] = [];
  const push = (run: NewRun): void => {
    if (run.text === "") return;
    const last = runs[runs.length - 1];
    if (last !== undefined && sameFormat(last, run)) last.text += run.text;
    else runs.push(run);
  };
  tokens.forEach((token, index) => {
    for (const flag of ["bold", "italic", "strike"] as const) active[flag] += flags[flag][index] as number;
    const format: Omit<NewRun, "text"> = {};
    if (active.bold > 0) format.bold = true;
    if (active.italic > 0) format.italic = true;
    if (active.strike > 0) format.strike = true;
    if (token.link !== undefined) {
      for (const run of token.link) push({ ...run, ...mergeFlags(run, format) });
    } else if (token.delimiter !== undefined) {
      push({ text: token.delimiter.char.repeat(token.delimiter.count), ...format });
    } else {
      push({ text: token.text, ...format, ...(token.code === true ? { code: true } : {}) });
    }
  });
  return runs;
}

function mergeFlags(run: NewRun, format: Omit<NewRun, "text">): Omit<NewRun, "text"> {
  const merged: Omit<NewRun, "text"> = {};
  if (run.bold === true || format.bold === true) merged.bold = true;
  if (run.italic === true || format.italic === true) merged.italic = true;
  if (run.strike === true || format.strike === true) merged.strike = true;
  return merged;
}
