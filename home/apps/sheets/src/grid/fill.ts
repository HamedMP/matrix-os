/**
 * Filling cells from their neighbours: the fill handle, Ctrl+D and Ctrl+R.
 *
 * A fill continues the pattern of its source cells:
 * - numbers continue a straight line (1, 2 gives 3, 4; 10, 20 gives 30),
 *   and a single number is copied;
 * - a date continues by a day; several dates continue their step;
 * - text that ends in a number counts on ("Item 1", "Item 2"; "Q1" to "Q2");
 * - names of weekdays and months go round their list;
 * - a formula is copied with its relative references moved along;
 * - anything else repeats.
 */

import { type CellAddress, type CellRange, type CellValue, formula as formulaEngine, isOfficeError } from "../session/engine";

export interface FillSource {
  value: CellValue;
  /** Formula text without the leading `=`, or null. */
  formula: string | null;
  /** True when the cell shows its number as a date. */
  isDate?: boolean;
}

export type FillDirection = "down" | "up" | "right" | "left";

export interface FillEdit {
  row: number;
  col: number;
  /** The source cell whose look the filled cell takes. */
  from: CellAddress;
  value?: CellValue;
  /** Formula text without the leading `=`. */
  formula?: string;
}

const LISTS: ReadonlyArray<readonly string[]> = [
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
];

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/** Least-squares line through the points (0, v0), (1, v1), ... as a function of the position. */
function trend(values: readonly number[]): (position: number) => number {
  const n = values.length;
  if (n === 1) return () => values[0] as number;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let x = 0; x < n; x++) {
    const y = values[x] as number;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return (position) => {
    const value = intercept + slope * position;
    // Sums of decimals leave noise in the last digits; cut it off.
    return Number(value.toPrecision(12));
  };
}

function matchCase(text: string, like: string): string {
  if (like === like.toUpperCase()) return text.toUpperCase();
  if (like === like.toLowerCase()) return text.toLowerCase();
  return text;
}

function listSeries(texts: readonly string[]): ((position: number) => string) | null {
  for (const list of LISTS) {
    const lower = list.map((entry) => entry.toLowerCase());
    const indexes = texts.map((text) => lower.indexOf(text.trim().toLowerCase()));
    if (indexes.some((index) => index < 0)) continue;
    const first = indexes[0] as number;
    const stepBy = indexes.length > 1 ? mod((indexes[1] as number) - first, list.length) : 1;
    const regular = indexes.every((index, i) => index === mod(first + stepBy * i, list.length));
    if (!regular) continue;
    return (position) => matchCase(list[mod(first + stepBy * position, list.length)] as string, texts[0] as string);
  }
  return null;
}

const TRAILING_NUMBER = /^(.*?)(\d+)$/s;

function textNumberSeries(texts: readonly string[]): ((position: number) => string) | null {
  const parts = texts.map((text) => TRAILING_NUMBER.exec(text));
  const first = parts[0];
  if (first === null || first === undefined) return null;
  const prefix = first[1] as string;
  const numbers: number[] = [];
  for (const part of parts) {
    if (part === null || part[1] !== prefix) return null;
    numbers.push(Number(part[2]));
  }
  const width = (first[2] as string).startsWith("0") ? (first[2] as string).length : 0;
  const stepBy = numbers.length > 1 ? (numbers[1] as number) - (numbers[0] as number) : 1;
  if (!numbers.every((value, i) => value === (numbers[0] as number) + stepBy * i)) return null;
  return (position) => {
    const value = (numbers[0] as number) + stepBy * position;
    // Counting below zero has no text form: repeat instead.
    if (value < 0) return texts[mod(position, texts.length)] as string;
    return `${prefix}${String(value).padStart(width, "0")}`;
  };
}

function shifted(formula: string, rows: number, cols: number): string {
  try {
    return formulaEngine.shiftFormulaText(formula, rows, cols);
  } catch (error: unknown) {
    // A formula the engine cannot parse is copied as it is.
    if (isOfficeError(error)) return formula;
    throw error;
  }
}

/**
 * Moves the relative references of a formula that is copied `rows` down and
 * `cols` to the right: `A1+$B$1` moved one row down is `A2+$B$1`. A reference
 * pushed off the sheet becomes `#REF!`.
 */
export function adjustFormula(formula: string, rows: number, cols: number): string {
  return rows === 0 && cols === 0 ? formula : shifted(formula, rows, cols);
}

type Filler = (position: number) => { value: CellValue } | { formula: string; index: number };

/**
 * The pattern of a run of source cells along the fill direction. `position`
 * counts cells from the first source cell: `source.length` is the first cell
 * after the run, -1 the first before it. With `series` false every cell
 * repeats (Ctrl+D, Ctrl+R).
 */
export function createFiller(source: readonly FillSource[], series = true): Filler {
  const n = source.length;
  const repeat: Filler = (position) => {
    const index = mod(position, n);
    const cell = source[index] as FillSource;
    return cell.formula !== null ? { formula: cell.formula, index } : { value: cell.value };
  };
  if (n === 0) return () => ({ value: null });
  if (!series || source.some((cell) => cell.formula !== null)) return repeat;
  if (source.every((cell) => typeof cell.value === "number")) {
    const numbers = source.map((cell) => cell.value as number);
    if (n === 1) {
      if (source[0]?.isDate !== true) return repeat;
      return (position) => ({ value: (numbers[0] as number) + position });
    }
    const line = trend(numbers);
    return (position) => ({ value: line(position) });
  }
  if (source.every((cell) => typeof cell.value === "string" && cell.value !== "")) {
    const texts = source.map((cell) => cell.value as string);
    const named = listSeries(texts) ?? textNumberSeries(texts);
    if (named !== null) return (position) => ({ value: named(position) });
  }
  return repeat;
}

/**
 * Which cells a drag of the fill handle fills: the range grows from `source`
 * towards `to` along one axis, the one in which the pointer is further
 * outside. Null while the pointer is inside the source.
 */
export function fillTarget(source: CellRange, to: CellAddress): { direction: FillDirection; target: CellRange } | null {
  const below = to.row - source.end.row;
  const above = source.start.row - to.row;
  const right = to.col - source.end.col;
  const left = source.start.col - to.col;
  const vertical = Math.max(below, above);
  const horizontal = Math.max(right, left);
  if (vertical <= 0 && horizontal <= 0) return null;
  if (vertical >= horizontal) {
    return below > 0
      ? { direction: "down", target: { start: { row: source.end.row + 1, col: source.start.col }, end: { row: to.row, col: source.end.col } } }
      : { direction: "up", target: { start: { row: to.row, col: source.start.col }, end: { row: source.start.row - 1, col: source.end.col } } };
  }
  return right > 0
    ? { direction: "right", target: { start: { row: source.start.row, col: source.end.col + 1 }, end: { row: source.end.row, col: to.col } } }
    : { direction: "left", target: { start: { row: source.start.row, col: to.col }, end: { row: source.end.row, col: source.start.col - 1 } } };
}

/**
 * The edits that fill `target` from `source`. For a vertical fill each column
 * continues its own pattern; for a horizontal fill each row does.
 */
export function planFill(
  source: CellRange,
  target: CellRange,
  direction: FillDirection,
  read: (row: number, col: number) => FillSource,
  series = true,
): FillEdit[] {
  const edits: FillEdit[] = [];
  const vertical = direction === "down" || direction === "up";
  const lines = vertical ? [source.start.col, source.end.col] : [source.start.row, source.end.row];
  const along = vertical ? [source.start.row, source.end.row] : [source.start.col, source.end.col];
  const span = vertical ? [target.start.row, target.end.row] : [target.start.col, target.end.col];
  for (let line = lines[0] as number; line <= (lines[1] as number); line++) {
    const cells: FillSource[] = [];
    for (let at = along[0] as number; at <= (along[1] as number); at++) cells.push(vertical ? read(at, line) : read(line, at));
    const filler = createFiller(cells, series);
    for (let at = span[0] as number; at <= (span[1] as number); at++) {
      const position = at - (along[0] as number);
      const result = filler(position);
      const row = vertical ? at : line;
      const col = vertical ? line : at;
      const sourceIndex = "formula" in result ? result.index : mod(position, cells.length);
      const sourceAt = (along[0] as number) + sourceIndex;
      const from = vertical ? { row: sourceAt, col: line } : { row: line, col: sourceAt };
      if ("formula" in result) {
        const moved = at - sourceAt;
        edits.push({ row, col, from, formula: adjustFormula(result.formula, vertical ? moved : 0, vertical ? 0 : moved) });
      } else {
        edits.push({ row, col, from, value: result.value });
      }
    }
  }
  return edits;
}

/**
 * Source and target of Ctrl+D (`down`) or Ctrl+R (`right`) for a selected
 * range: the first row or column fills the rest; a range of one row or
 * column is filled from the row above or the column to the left. Null when
 * there is nothing to fill from.
 */
export function fillFromEdge(range: CellRange, direction: "down" | "right"): { source: CellRange; target: CellRange } | null {
  if (direction === "down") {
    if (range.end.row > range.start.row) {
      return {
        source: { start: range.start, end: { row: range.start.row, col: range.end.col } },
        target: { start: { row: range.start.row + 1, col: range.start.col }, end: range.end },
      };
    }
    if (range.start.row === 0) return null;
    return {
      source: { start: { row: range.start.row - 1, col: range.start.col }, end: { row: range.start.row - 1, col: range.end.col } },
      target: range,
    };
  }
  if (range.end.col > range.start.col) {
    return {
      source: { start: range.start, end: { row: range.end.row, col: range.start.col } },
      target: { start: { row: range.start.row, col: range.start.col + 1 }, end: range.end },
    };
  }
  if (range.start.col === 0) return null;
  return {
    source: { start: { row: range.start.row, col: range.start.col - 1 }, end: { row: range.end.row, col: range.start.col - 1 } },
    target: range,
  };
}
