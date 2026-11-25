/**
 * Finds the cell references in formula text without parsing the formula.
 *
 * Reference rewriting (shared formulas, inserted and deleted rows and
 * columns, renamed and removed sheets) works on these tokens and leaves
 * every other character of the formula as it was written, so functions the
 * formula engine does not know, `_xlfn.` prefixes and spacing all survive.
 *
 * Skipped on purpose: text in string literals, function names, defined
 * names, structured table references, references into other workbooks
 * (`[1]Sheet1!A1`) and references across several sheets (`Jan:Mar!A1`).
 */

import { MAX_ROWS, columnIndexOrNegative } from "./a1.js";

export interface RefCorner {
  row: number;
  col: number;
  rowAbs: boolean;
  colAbs: boolean;
}

export interface RefToken {
  /** Span of the whole reference in the formula text, sheet prefix included. */
  start: number;
  end: number;
  /** Where the address begins, after `!`. Equal to `start` without a sheet prefix. */
  refStart: number;
  /** Sheet name as written without quotes, or null for the formula's own sheet. */
  sheet: string | null;
  /**
   * `cols` is `A:C` (rows of the corners are 0), `rows` is `2:5` (columns are
   * 0), `name` is a sheet-qualified defined name such as `Sheet1!Total`.
   */
  kind: "cell" | "range" | "cols" | "rows" | "name";
  /** Corners in the order written. For a cell both are the same position. */
  a: RefCorner;
  b: RefCorner;
}

const CELL = /(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/y;
const COLS = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y;
const ROWS = /(\$?)([0-9]{1,7}):(\$?)([0-9]{1,7})/y;
const ERROR_LITERAL = /#[A-Za-z0-9/]+[!?]?/y;

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 || // _
    code === 46 || // .
    code === 36 || // $
    code === 63 || // ?
    code === 92 || // \
    code > 127
  );
}

function wordEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWordChar(text.charCodeAt(i))) i++;
  return i;
}

/** True when the character at `index` cannot continue a reference. */
function isBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const code = text.charCodeAt(index);
  return !isWordChar(code) && code !== 40; // (
}

function skipString(text: string, from: number): number {
  let i = from + 1;
  for (;;) {
    const quote = text.indexOf('"', i);
    if (quote < 0) return text.length;
    if (text.charCodeAt(quote + 1) !== 34) return quote + 1;
    i = quote + 2;
  }
}

function skipBracket(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 91) depth++;
    else if (code === 93 && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Reads `'…'` with `''` as an escaped quote. Returns the name and the index after the closing quote. */
function readQuoted(text: string, from: number): { name: string; end: number } | null {
  let i = from + 1;
  let name = "";
  for (;;) {
    const quote = text.indexOf("'", i);
    if (quote < 0) return null;
    name += text.slice(i, quote);
    if (text.charCodeAt(quote + 1) === 39) {
      name += "'";
      i = quote + 2;
    } else {
      return { name, end: quote + 1 };
    }
  }
}

function cellCorner(match: RegExpExecArray, offset: number): RefCorner | null {
  const col = columnIndexOrNegative(match[offset + 1] as string);
  const row = Number(match[offset + 3]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col, rowAbs: match[offset + 2] === "$", colAbs: match[offset] === "$" };
}

type Address = Pick<RefToken, "kind" | "a" | "b" | "end">;

/** Reads a cell, range, column range or row range that starts at `from`. */
function readAddress(text: string, from: number): Address | null {
  CELL.lastIndex = from;
  const first = CELL.exec(text);
  if (first !== null) {
    const a = cellCorner(first, 1);
    const afterFirst = CELL.lastIndex;
    if (a !== null) {
      if (text.charCodeAt(afterFirst) === 58) {
        CELL.lastIndex = afterFirst + 1;
        const second = CELL.exec(text);
        if (second !== null && isBoundary(text, CELL.lastIndex)) {
          const b = cellCorner(second, 1);
          if (b !== null) return { kind: "range", a, b, end: CELL.lastIndex };
        }
      }
      if (isBoundary(text, afterFirst)) return { kind: "cell", a, b: { ...a }, end: afterFirst };
    }
  }
  COLS.lastIndex = from;
  const cols = COLS.exec(text);
  if (cols !== null && isBoundary(text, COLS.lastIndex)) {
    const c1 = columnIndexOrNegative(cols[2] as string);
    const c2 = columnIndexOrNegative(cols[4] as string);
    if (c1 >= 0 && c2 >= 0) {
      return {
        kind: "cols",
        a: { row: 0, col: c1, rowAbs: false, colAbs: cols[1] === "$" },
        b: { row: 0, col: c2, rowAbs: false, colAbs: cols[3] === "$" },
        end: COLS.lastIndex,
      };
    }
  }
  ROWS.lastIndex = from;
  const rows = ROWS.exec(text);
  if (rows !== null && isBoundary(text, ROWS.lastIndex)) {
    const r1 = Number(rows[2]) - 1;
    const r2 = Number(rows[4]) - 1;
    if (r1 >= 0 && r2 >= 0 && r1 < MAX_ROWS && r2 < MAX_ROWS) {
      return {
        kind: "rows",
        a: { row: r1, col: 0, rowAbs: rows[1] === "$", colAbs: false },
        b: { row: r2, col: 0, rowAbs: rows[3] === "$", colAbs: false },
        end: ROWS.lastIndex,
      };
    }
  }
  return null;
}

const NO_CORNER: RefCorner = Object.freeze({ row: 0, col: 0, rowAbs: false, colAbs: false });

/** Reads what follows `sheet!`: an address, or a name, or nothing usable. */
function readQualified(text: string, start: number, afterBang: number, sheet: string, out: RefToken[]): number {
  const address = readAddress(text, afterBang);
  if (address !== null) {
    out.push({ start, refStart: afterBang, sheet, ...address });
    return address.end;
  }
  const end = wordEnd(text, afterBang);
  if (end > afterBang && text.charCodeAt(end) !== 40) {
    out.push({ start, end, refStart: afterBang, sheet, kind: "name", a: NO_CORNER, b: NO_CORNER });
  }
  return Math.max(end, afterBang);
}

/** Every reference in a formula, in source order. `text` has no leading `=`. */
export function scanRefs(text: string): RefToken[] {
  const out: RefToken[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (code === 34) {
      i = skipString(text, i);
    } else if (code === 35) {
      // `#REF!`, `#N/A`: the `!` is not a sheet separator.
      ERROR_LITERAL.lastIndex = i;
      i = ERROR_LITERAL.exec(text) === null ? i + 1 : ERROR_LITERAL.lastIndex;
    } else if (code === 39) {
      const quoted = readQuoted(text, i);
      if (quoted === null) break;
      if (text.charCodeAt(quoted.end) !== 33) {
        i = quoted.end;
      } else if (quoted.name.includes("[") || quoted.name.includes(":")) {
        // Another workbook, or a span of sheets: left alone.
        const address = readAddress(text, quoted.end + 1);
        i = address === null ? quoted.end + 1 : address.end;
      } else {
        i = readQualified(text, i, quoted.end + 1, quoted.name, out);
      }
    } else if (code === 91) {
      // `[1]Sheet1!A1`: skip the workbook index, the sheet name and the address.
      i = skipBracket(text, i);
      const end = wordEnd(text, i);
      if (text.charCodeAt(end) === 33) {
        const address = readAddress(text, end + 1);
        i = address === null ? end + 1 : address.end;
      } else {
        i = end;
      }
    } else if (isWordChar(code)) {
      const end = wordEnd(text, i);
      const next = text.charCodeAt(end);
      if (next === 33) {
        i = readQualified(text, i, end + 1, text.slice(i, end), out);
      } else if (next === 40) {
        i = end;
      } else if (next === 91) {
        i = skipBracket(text, end);
      } else if (next === 58 && text.charCodeAt(wordEnd(text, end + 1)) === 33 && wordEnd(text, end + 1) > end + 1) {
        // `Jan:Mar!A1`: a span of sheets.
        const bang = wordEnd(text, end + 1);
        const address = readAddress(text, bang + 1);
        i = address === null ? bang + 1 : address.end;
      } else {
        const address = readAddress(text, i);
        if (address !== null && address.end >= end) {
          out.push({ start: i, refStart: i, sheet: null, ...address });
          i = address.end;
        } else {
          i = end;
        }
      }
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Rebuilds a formula with some references replaced. `map` returns the new
 * text for a reference (sheet prefix included), or null to keep it.
 */
export function replaceRefs(text: string, refs: readonly RefToken[], map: (ref: RefToken) => string | null): string {
  let out = "";
  let cursor = 0;
  let changed = false;
  for (const ref of refs) {
    const replacement = map(ref);
    if (replacement === null) continue;
    out += text.slice(cursor, ref.start) + replacement;
    cursor = ref.end;
    changed = true;
  }
  return changed ? out + text.slice(cursor) : text;
}
