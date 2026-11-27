/**
 * Text functions that cut, join, search and convert strings.
 * Positions are one-based and count UTF-16 code units, as the cell does.
 */

import type { FormulaArg, FormulaError, FormulaScalar, FormulaValue, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, MAX_BROADCAST_CELLS, extentOf, flattenValues, isArray, isError, toText } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { boolArg, boundedText, intArg, MAX_TEXT_LENGTH, textArg } from "./args.js";
import { hasWildcard, wildcardSearch } from "./wildcard.js";

type Impl = (args: readonly FormulaArg[]) => FormulaValue;

/** Most blank cells past the stored values of its references that one TEXTJOIN walks; more give `#VALUE!`. */
const MAX_BLANK_CELLS = MAX_BROADCAST_CELLS;

/** Wraps a function of text arguments: converts each to text and returns the first error. */
function withTexts(count: number, fn: (texts: string[], args: readonly FormulaArg[]) => FormulaValue): Impl {
  return (args) => {
    const texts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const text = textArg(args[i]);
      if (isError(text)) return text;
      texts.push(text);
    }
    return fn(texts, args);
  };
}

function joinAll(args: readonly FormulaArg[]): FormulaValue {
  let out = "";
  for (const arg of args) {
    for (const cell of flattenValues(arg)) {
      const text = toText(cell);
      if (isError(text)) return text;
      out += text;
      if (out.length > MAX_TEXT_LENGTH) return ERR.VALUE;
    }
  }
  return out;
}

function textJoin(args: readonly FormulaArg[]): FormulaValue {
  const delimiters: string[] = [];
  for (const cell of flattenValues(args[0] ?? null)) {
    const text = toText(cell);
    if (isError(text)) return text;
    delimiters.push(text);
  }
  const ignoreEmpty = boolArg(args[1], true);
  if (isError(ignoreEmpty)) return ignoreEmpty;
  // Blank cells add only delimiters, so with none to add the blanks past a reference's stored values change nothing.
  const walkBlanks = !ignoreEmpty && delimiters.some((delimiter) => delimiter !== "");
  let out = "";
  let parts = 0;
  let blanks = 0;
  const add = (cell: FormulaScalar): FormulaError | null => {
    const text = toText(cell);
    if (isError(text)) return text;
    if (ignoreEmpty && text === "") return null;
    if (parts > 0 && delimiters.length > 0) out += delimiters[(parts - 1) % delimiters.length];
    out += text;
    parts += 1;
    return out.length > MAX_TEXT_LENGTH ? ERR.VALUE : null;
  };
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i] ?? null;
    if (!walkBlanks || !isArray(arg) || arg.ref === null) {
      for (const cell of flattenValues(arg)) {
        const failed = add(cell);
        if (failed !== null) return failed;
      }
      continue;
    }
    // A reference holds values only for the used part of the sheet; every cell of its bounds still takes a delimiter.
    const { rows, cols } = extentOf(arg);
    for (let r = 0; r < rows; r += 1) {
      const line = r < arg.rows ? arg.values[r] : undefined;
      for (let c = 0; c < cols; c += 1) {
        const stored = line !== undefined && c < arg.cols;
        // Delimiters that are mostly empty could make a whole-sheet reference walk for long without growing the text.
        if (!stored && ++blanks > MAX_BLANK_CELLS) return ERR.VALUE;
        const failed = add(stored ? (line[c] as FormulaScalar) : null);
        if (failed !== null) return failed;
      }
    }
  }
  return out;
}

/** An omitted count is 1; a count left empty (`LEFT(A1,)`) or blank is 0. */
function countArg(value: FormulaArg | undefined): number | FormulaError {
  return value === undefined ? 1 : intArg(value);
}

function left([text]: string[], args: readonly FormulaArg[]): FormulaValue {
  const n = countArg(args[1]);
  if (isError(n)) return n;
  return n < 0 ? ERR.VALUE : (text as string).slice(0, n);
}

function right([text]: string[], args: readonly FormulaArg[]): FormulaValue {
  const n = countArg(args[1]);
  if (isError(n)) return n;
  if (n < 0) return ERR.VALUE;
  const value = text as string;
  return n === 0 ? "" : value.slice(Math.max(0, value.length - n));
}

function mid([text]: string[], args: readonly FormulaArg[]): FormulaValue {
  const start = intArg(args[1]);
  if (isError(start)) return start;
  const count = intArg(args[2]);
  if (isError(count)) return count;
  if (start < 1 || count < 0) return ERR.VALUE;
  return (text as string).slice(start - 1, start - 1 + count);
}

const LETTER = /\p{L}/u;

function proper(text: string): string {
  let out = "";
  let afterLetter = false;
  for (const ch of text) {
    const isLetter = LETTER.test(ch);
    out += isLetter ? (afterLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    afterLetter = isLetter;
  }
  return out;
}

function trim(text: string): string {
  return text.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
}

function substitute([text, oldText, newText]: string[], args: readonly FormulaArg[]): FormulaValue {
  const source = text as string;
  const find = oldText as string;
  const replacement = newText as string;
  if (find === "") return source;
  if (args[3] !== undefined && args[3] !== null) {
    const instance = intArg(args[3]);
    if (isError(instance)) return instance;
    if (instance < 1) return ERR.VALUE;
    let at = -1;
    for (let seen = 0; seen < instance; seen += 1) {
      at = source.indexOf(find, at + (seen === 0 ? 0 : find.length));
      if (at === -1) return source;
    }
    return boundedText(source.slice(0, at) + replacement + source.slice(at + find.length));
  }
  return boundedText(source.split(find).join(replacement));
}

function replace([oldText, , , newText]: string[], args: readonly FormulaArg[]): FormulaValue {
  const start = intArg(args[1]);
  if (isError(start)) return start;
  const count = intArg(args[2]);
  if (isError(count)) return count;
  if (start < 1 || count < 0) return ERR.VALUE;
  const source = oldText as string;
  return boundedText(source.slice(0, start - 1) + (newText as string) + source.slice(start - 1 + count));
}

function findIn(caseSensitive: boolean): (texts: string[], args: readonly FormulaArg[]) => FormulaValue {
  return ([needle, haystack], args) => {
    const start = intArg(args[2], 1);
    if (isError(start)) return start;
    const within = haystack as string;
    const find = needle as string;
    if (start < 1 || start > within.length + 1) return ERR.VALUE;
    let at: number;
    if (caseSensitive) at = within.indexOf(find, start - 1);
    else if (hasWildcard(find)) at = wildcardSearch(find, within, start - 1);
    else at = within.toUpperCase().indexOf(find.toUpperCase(), start - 1);
    return at === -1 ? ERR.VALUE : at + 1;
  };
}

function rept([text]: string[], args: readonly FormulaArg[]): FormulaValue {
  const n = intArg(args[1]);
  if (isError(n)) return n;
  if (n < 0) return ERR.VALUE;
  const value = text as string;
  if (value.length * n > MAX_TEXT_LENGTH) return ERR.VALUE;
  return value.repeat(n);
}

/** Characters 128 to 159 of the Windows-1252 code page, the one spreadsheets use for CHAR and CODE. */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d,
  0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
];

function char(args: readonly FormulaArg[]): FormulaValue {
  const n = intArg(args[0]);
  if (isError(n)) return n;
  if (n < 1 || n > 255) return ERR.VALUE;
  return String.fromCharCode(n >= 128 && n <= 159 ? (CP1252_HIGH[n - 128] as number) : n);
}

function code([text]: string[]): FormulaValue {
  const value = text as string;
  if (value === "") return ERR.VALUE;
  const unit = value.charCodeAt(0);
  if (unit <= 255 && (unit < 128 || unit > 159)) return unit;
  const high = CP1252_HIGH.indexOf(unit);
  return high === -1 ? 63 : high + 128;
}

function exact([a, b]: string[]): FormulaValue {
  return a === b;
}

function t(args: readonly FormulaArg[]): FormulaValue {
  const value = args[0] ?? null;
  if (isError(value)) return value;
  return typeof value === "string" ? value : "";
}

function lift(fn: (text: string) => string): Impl {
  return withTexts(1, ([text]) => fn(text as string));
}

/** Registers the string functions. */
export function registerStringFunctions(registry: FunctionRegistry): void {
  const scalar = { ranges: "none" as const };
  registerFunction(registry, "CONCAT", joinAll, { minArgs: 1, maxArgs: 254 });
  registerFunction(registry, "CONCATENATE", joinAll, { minArgs: 1, maxArgs: 255, ...scalar });
  registerFunction(registry, "TEXTJOIN", textJoin, { minArgs: 3, maxArgs: 252, ranges: (i) => i !== 1 });
  registerFunction(registry, "LEFT", withTexts(1, left), { minArgs: 1, maxArgs: 2, ...scalar });
  registerFunction(registry, "RIGHT", withTexts(1, right), { minArgs: 1, maxArgs: 2, ...scalar });
  registerFunction(registry, "MID", withTexts(1, mid), { minArgs: 3, maxArgs: 3, ...scalar });
  registerFunction(registry, "LEN", withTexts(1, ([text]) => (text as string).length), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "LOWER", lift((s) => s.toLowerCase()), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "UPPER", lift((s) => s.toUpperCase()), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "PROPER", lift(proper), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "TRIM", lift(trim), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "SUBSTITUTE", withTexts(3, substitute), { minArgs: 3, maxArgs: 4, ...scalar });
  registerFunction(registry, "REPLACE", withTexts(4, replace), { minArgs: 4, maxArgs: 4, ...scalar });
  registerFunction(registry, "FIND", withTexts(2, findIn(true)), { minArgs: 2, maxArgs: 3, ...scalar });
  registerFunction(registry, "SEARCH", withTexts(2, findIn(false)), { minArgs: 2, maxArgs: 3, ...scalar });
  registerFunction(registry, "REPT", withTexts(1, rept), { minArgs: 2, maxArgs: 2, ...scalar });
  registerFunction(registry, "EXACT", withTexts(2, exact), { minArgs: 2, maxArgs: 2, ...scalar });
  registerFunction(registry, "CHAR", char, { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "CODE", withTexts(1, code), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "T", t, { minArgs: 1, maxArgs: 1, ...scalar });
}
