/**
 * Helpers for editing a formula as text: finding its references (to colour
 * them and to outline their ranges on the grid), inserting a reference picked
 * on the grid, completing function names and knowing which argument of which
 * function the caret is in.
 *
 * These work on text that is still being typed, so they tolerate formulas
 * that do not parse yet; the engine's parser is not used here.
 */

import { type CellRange, MAX_COLS, MAX_ROWS, columnLabel } from "../session/engine";

export interface FormulaRef {
  /** Offsets in the text, end exclusive. */
  start: number;
  end: number;
  text: string;
  /** Sheet name as written, without quotes, or null for the formula's own sheet. */
  sheet: string | null;
  range: CellRange;
  /** Index of the colour for this reference; the same reference gets the same colour. */
  color: number;
}

/** Number of colours references cycle through. */
export const REFERENCE_COLORS = 7;

const IDENT_CHAR = /[A-Za-z0-9_.]/;
const SHEET = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!/y;
const CELL_RANGE = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?::(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7}))?/y;
const COLUMN_RANGE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y;
const ROW_RANGE = /(\$?)(\d{1,7}):(\$?)(\d{1,7})/y;

function columnOf(label: string): number {
  let value = 0;
  for (const ch of label.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value - 1;
}

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function normalized(a: { row: number; col: number }, b: { row: number; col: number }): CellRange | null {
  const range: CellRange = {
    start: { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) },
    end: { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) },
  };
  if (range.start.row < 0 || range.start.col < 0 || range.end.row >= MAX_ROWS || range.end.col >= MAX_COLS) return null;
  return range;
}

function referenceAt(text: string, at: number): { end: number; range: CellRange } | null {
  const ends = (end: number): boolean => {
    const next = text[end];
    return next === undefined || !(IDENT_CHAR.test(next) || next === "(" || next === "!" || next === "$");
  };
  const cell = matchAt(CELL_RANGE, text, at);
  if (cell !== null && ends(at + cell[0].length)) {
    const first = { row: Number(cell[4]) - 1, col: columnOf(cell[2] as string) };
    const second = cell[6] === undefined ? first : { row: Number(cell[8]) - 1, col: columnOf(cell[6]) };
    const range = normalized(first, second);
    if (range !== null) return { end: at + cell[0].length, range };
  }
  const columns = matchAt(COLUMN_RANGE, text, at);
  if (columns !== null && ends(at + columns[0].length)) {
    const range = normalized({ row: 0, col: columnOf(columns[2] as string) }, { row: MAX_ROWS - 1, col: columnOf(columns[4] as string) });
    if (range !== null) return { end: at + columns[0].length, range };
  }
  const rows = matchAt(ROW_RANGE, text, at);
  if (rows !== null && ends(at + rows[0].length)) {
    const range = normalized({ row: Number(rows[2]) - 1, col: 0 }, { row: Number(rows[4]) - 1, col: MAX_COLS - 1 });
    if (range !== null) return { end: at + rows[0].length, range };
  }
  return null;
}

/** True when the text is a formula being typed. */
export function isFormulaText(text: string): boolean {
  return text.startsWith("=");
}

/** The cell and range references of a formula in source order. Empty for text that is not a formula. */
export function scanReferences(text: string): FormulaRef[] {
  if (!isFormulaText(text)) return [];
  const refs: FormulaRef[] = [];
  const colors = new Map<string, number>();
  let i = 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      // A string literal; `""` inside it is a quote.
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    const previous = text[i - 1] as string;
    if (IDENT_CHAR.test(previous) || previous === "$" || previous === "'") {
      i++;
      continue;
    }
    let at = i;
    let sheet: string | null = null;
    const prefix = matchAt(SHEET, text, at);
    if (prefix !== null) {
      sheet = prefix[1] !== undefined ? prefix[1].replace(/''/g, "'") : (prefix[2] as string);
      at += prefix[0].length;
    }
    const found = referenceAt(text, at);
    if (found === null) {
      // Skip a whole identifier (a function or a name) so that its tail is not read as a reference.
      if (/[A-Za-z_]/.test(ch)) {
        while (i < text.length && IDENT_CHAR.test(text[i] as string)) i++;
      } else if (ch === "'") {
        const close = text.indexOf("'", i + 1);
        i = close < 0 ? text.length : close + 1;
      } else {
        i++;
      }
      continue;
    }
    const key = `${(sheet ?? "").toLowerCase()}|${found.range.start.row},${found.range.start.col},${found.range.end.row},${found.range.end.col}`;
    let color = colors.get(key);
    if (color === undefined) {
      color = colors.size % REFERENCE_COLORS;
      colors.set(key, color);
    }
    refs.push({ start: i, end: found.end, text: text.slice(i, found.end), sheet, range: found.range, color });
    i = found.end;
  }
  return refs;
}

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** A range as formula text: `B2`, `B2:C5`, `A:C`, `2:5`, with the sheet in front when given. */
export function formatReference(range: CellRange, sheetName: string | null = null): string {
  const wholeColumns = range.start.row === 0 && range.end.row === MAX_ROWS - 1;
  const wholeRows = range.start.col === 0 && range.end.col === MAX_COLS - 1;
  let text: string;
  if (wholeColumns && !wholeRows) text = `${columnLabel(range.start.col)}:${columnLabel(range.end.col)}`;
  else if (wholeRows && !wholeColumns) text = `${range.start.row + 1}:${range.end.row + 1}`;
  else {
    const first = `${columnLabel(range.start.col)}${range.start.row + 1}`;
    const last = `${columnLabel(range.end.col)}${range.end.row + 1}`;
    text = first === last ? first : `${first}:${last}`;
  }
  return sheetName === null ? text : `${quoteSheet(sheetName)}!${text}`;
}

/** True when the caret is inside a string literal of the formula. */
function insideString(text: string, caret: number): boolean {
  let inside = false;
  for (let i = 1; i < caret && i < text.length; i++) if (text[i] === '"') inside = !inside;
  return inside;
}

/**
 * True when a reference picked on the grid can be put at the caret: the
 * text is a formula and the caret follows `=`, an operator, an opening
 * bracket or an argument separator.
 */
export function canInsertReference(text: string, caret: number): boolean {
  if (!isFormulaText(text) || caret < 1 || insideString(text, caret)) return false;
  let i = caret - 1;
  while (i > 0 && text[i] === " ") i--;
  return "=+-*/^&(,;:<>".includes(text[i] as string);
}

export interface TextEdit {
  text: string;
  /** Caret position after the edit. */
  caret: number;
}

/** Replaces `start..end` of the text with a reference and puts the caret after it. */
export function insertReference(text: string, start: number, end: number, reference: string): TextEdit {
  return { text: text.slice(0, start) + reference + text.slice(end), caret: start + reference.length };
}

const ONE_CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;

function cycleCell(cell: string): string {
  const match = ONE_CELL.exec(cell);
  if (match === null) return cell;
  const col = match[2] as string;
  const row = match[4] as string;
  const state = `${match[1] === "$" ? "c" : ""}${match[3] === "$" ? "r" : ""}`;
  // A1 -> $A$1 -> A$1 -> $A1 -> A1
  if (state === "") return `$${col}$${row}`;
  if (state === "cr") return `${col}$${row}`;
  if (state === "r") return `$${col}${row}`;
  return `${col}${row}`;
}

/** F4: cycles the reference at the caret between relative and absolute forms. Null when the caret is on no cell reference. */
export function cycleAbsolute(text: string, caret: number): TextEdit | null {
  const ref = scanReferences(text).find((entry) => caret >= entry.start && caret <= entry.end);
  if (ref === undefined) return null;
  const bang = ref.text.lastIndexOf("!");
  const prefix = bang < 0 ? "" : ref.text.slice(0, bang + 1);
  const body = bang < 0 ? ref.text : ref.text.slice(bang + 1);
  const cycled = body.split(":").map(cycleCell).join(":");
  if (cycled === body) return null;
  const next = prefix + cycled;
  return { text: text.slice(0, ref.start) + next + text.slice(ref.end), caret: ref.start + next.length };
}

export interface Completion {
  /** Offsets of the partial name in the text, end exclusive. */
  start: number;
  end: number;
  /** The letters typed so far, upper case. */
  prefix: string;
}

/** The function name being typed at the caret, or null. */
export function completionAt(text: string, caret: number): Completion | null {
  if (!isFormulaText(text) || insideString(text, caret)) return null;
  const next = text[caret];
  if (next !== undefined && (IDENT_CHAR.test(next) || next === "(")) return null;
  let start = caret;
  while (start > 1 && IDENT_CHAR.test(text[start - 1] as string)) start--;
  if (start === caret) return null;
  const word = text.slice(start, caret);
  if (!/^[A-Za-z_]/.test(word)) return null;
  const before = text[start - 1] as string;
  if (before === "$" || before === "!" || before === "'") return null;
  // `A1`, `AB12`: a cell being typed, not a function.
  if (/^[A-Za-z]{1,3}\d+$/.test(word)) return null;
  return { start, end: caret, prefix: word.toUpperCase() };
}

/** Function names that start with the prefix, shortest first, then by name. */
export function matchFunctions(prefix: string, names: readonly string[], limit = 8): string[] {
  const upper = prefix.toUpperCase();
  if (upper === "") return [];
  const hits = names.filter((name) => name.startsWith(upper));
  hits.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return hits.slice(0, limit);
}

/** Replaces the partial name with `NAME(` and puts the caret inside the brackets. */
export function applyCompletion(text: string, completion: Completion, name: string): TextEdit {
  const follows = text[completion.end] === "(";
  const inserted = follows ? name : `${name}(`;
  return {
    text: text.slice(0, completion.start) + inserted + text.slice(completion.end),
    caret: completion.start + inserted.length + (follows ? 1 : 0),
  };
}

export interface CallContext {
  /** Function name, upper case. */
  name: string;
  /** Zero-based index of the argument the caret is in. */
  argument: number;
}

/** The innermost function call that encloses the caret, or null. */
export function callAt(text: string, caret: number): CallContext | null {
  if (!isFormulaText(text)) return null;
  const stack: Array<{ name: string | null; argument: number; braces: number }> = [];
  let i = 1;
  const end = Math.min(caret, text.length);
  while (i < end) {
    const ch = text[i] as string;
    if (ch === '"') {
      i++;
      while (i < end && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && !IDENT_CHAR.test(text[i - 1] as string)) {
      let j = i;
      while (j < text.length && IDENT_CHAR.test(text[j] as string)) j++;
      if (text[j] === "(" && j < end) {
        stack.push({ name: text.slice(i, j).toUpperCase(), argument: 0, braces: 0 });
        i = j + 1;
        continue;
      }
      i = j;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === "(") stack.push({ name: null, argument: 0, braces: 0 });
    else if (ch === ")") stack.pop();
    else if (top !== undefined) {
      if (ch === "{") top.braces++;
      else if (ch === "}") top.braces = Math.max(0, top.braces - 1);
      else if ((ch === "," || ch === ";") && top.braces === 0) top.argument++;
    }
    i++;
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const frame = stack[k] as { name: string | null; argument: number };
    if (frame.name !== null) return { name: frame.name, argument: frame.argument };
  }
  return null;
}
