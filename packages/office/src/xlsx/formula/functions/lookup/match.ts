/**
 * Match semantics shared by the lookup functions.
 *
 * - Exact match ignores case. Numbers equal numbers, text equals text,
 *   booleans equal booleans: `1` never matches `"1"`. With wildcards on
 *   (MATCH, VLOOKUP, HLOOKUP and XMATCH/XLOOKUP mode 2), text may hold
 *   `*`, `?` and `~`. A blank lookup value matches nothing.
 * - Approximate match on ascending data finds the last value of the
 *   lookup's type that is not greater than it, stopping at the first value
 *   of that type that is greater. Values of other types, blanks and errors
 *   are skipped. This is what a binary search over sorted data finds, and
 *   it keeps the idioms `LOOKUP(2,1/(cond),range)` and
 *   `MATCH(9.99E+307,range)` (last match) working.
 * - Descending approximate match (MATCH type -1) mirrors it.
 */

import type { FormulaArray, FormulaScalar } from "../../../../api/formula.js";
import { compareValues, isError } from "../../coerce.js";
import { hasWildcard, wildcardMatcher } from "../text/wildcard.js";

/** A one-dimensional view of a row or column of values. */
export interface Vector {
  readonly length: number;
  at(index: number): FormulaScalar;
}

/** The full size of an array: its reference bounds when it has them, otherwise its values. */
export function shapeOf(array: FormulaArray): { rows: number; cols: number } {
  const ref = array.ref;
  if (ref === null) return { rows: array.rows, cols: array.cols };
  return { rows: ref.endRow - ref.startRow + 1, cols: ref.endCol - ref.startCol + 1 };
}

/** Column `col` of an array as a vector over its values. */
export function columnVector(array: FormulaArray, col: number): Vector {
  return {
    length: col < array.cols ? array.rows : 0,
    at: (i) => (array.values[i] as FormulaScalar[])[col] as FormulaScalar,
  };
}

/** Row `row` of an array as a vector over its values. */
export function rowVector(array: FormulaArray, row: number): Vector {
  const line = array.values[row];
  return { length: line === undefined ? 0 : line.length, at: (i) => (line as FormulaScalar[])[i] as FormulaScalar };
}

/**
 * The array as a vector when it is one row or one column (by its full
 * shape), with its orientation; null for a two-dimensional array.
 */
export function vectorOf(array: FormulaArray): { vector: Vector; horizontal: boolean } | null {
  const shape = shapeOf(array);
  if (shape.cols === 1) return { vector: columnVector(array, 0), horizontal: false };
  if (shape.rows === 1) return { vector: rowVector(array, 0), horizontal: true };
  return null;
}

type Kind = "number" | "string" | "boolean" | "other";

function kindOf(value: FormulaScalar): Kind {
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return "other";
}

/** A predicate for the cells that match a lookup value exactly. */
export function exactPredicate(lookup: FormulaScalar, wildcards: boolean): (cell: FormulaScalar) => boolean {
  if (lookup === null || isError(lookup)) return () => false;
  if (typeof lookup === "string" && wildcards && hasWildcard(lookup)) {
    const matches = wildcardMatcher(lookup);
    return (cell) => typeof cell === "string" && matches(cell);
  }
  const kind = kindOf(lookup);
  return (cell) => kindOf(cell) === kind && compareValues(cell, lookup) === 0;
}

/** Index of the first (or, with `reverse`, last) exact match, or -1. */
export function exactIndex(lookup: FormulaScalar, vector: Vector, wildcards: boolean, reverse = false): number {
  const matches = exactPredicate(lookup, wildcards);
  if (reverse) {
    for (let i = vector.length - 1; i >= 0; i -= 1) if (matches(vector.at(i))) return i;
    return -1;
  }
  for (let i = 0; i < vector.length; i += 1) if (matches(vector.at(i))) return i;
  return -1;
}

/**
 * Approximate match on sorted data: ascending finds the last value not
 * greater than the lookup, descending the last value not less. -1 when none.
 */
export function approximateIndex(lookup: FormulaScalar, vector: Vector, descending = false): number {
  if (lookup === null || isError(lookup)) return -1;
  const kind = kindOf(lookup);
  let found = -1;
  for (let i = 0; i < vector.length; i += 1) {
    const cell = vector.at(i);
    if (kindOf(cell) !== kind) continue;
    const order = compareValues(cell, lookup);
    if (descending ? order < 0 : order > 0) break;
    found = i;
  }
  return found;
}

/** XMATCH and XLOOKUP match modes. */
export type MatchMode = 0 | -1 | 1 | 2;
/** XMATCH and XLOOKUP search modes. */
export type SearchMode = 1 | -1 | 2 | -2;

/** Exact match, or else the nearest smaller (-1) or larger (1) value, scanning in search order. */
function nearestIndex(lookup: FormulaScalar, vector: Vector, mode: -1 | 1, reverse: boolean): number {
  const kind = kindOf(lookup);
  let best = -1;
  let bestValue: FormulaScalar = null;
  for (let k = 0; k < vector.length; k += 1) {
    const i = reverse ? vector.length - 1 - k : k;
    const cell = vector.at(i);
    if (kindOf(cell) !== kind) continue;
    const order = compareValues(cell, lookup);
    if (order === 0) return i;
    if (mode === -1 ? order > 0 : order < 0) continue;
    if (best === -1 || (mode === -1 ? compareValues(cell, bestValue) > 0 : compareValues(cell, bestValue) < 0)) {
      best = i;
      bestValue = cell;
    }
  }
  return best;
}

/** Binary search over data sorted ascending (`descending` false) or descending. */
function binaryIndex(lookup: FormulaScalar, vector: Vector, mode: -1 | 0 | 1, descending: boolean): number {
  const before = (cell: FormulaScalar): boolean => {
    const order = compareValues(cell, lookup);
    return descending ? order > 0 : order < 0;
  };
  let lo = 0;
  let hi = vector.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(vector.at(mid))) lo = mid + 1;
    else hi = mid;
  }
  if (lo < vector.length && kindOf(vector.at(lo)) === kindOf(lookup) && compareValues(vector.at(lo), lookup) === 0) {
    return lo;
  }
  if (mode === 0) return -1;
  // Ascending: lo is the first larger value, lo - 1 the last smaller. Descending: the reverse.
  const smaller = descending ? lo : lo - 1;
  const larger = descending ? lo - 1 : lo;
  const pick = mode === -1 ? smaller : larger;
  if (pick < 0 || pick >= vector.length) return -1;
  return kindOf(vector.at(pick)) === kindOf(lookup) ? pick : -1;
}

/** XMATCH semantics. Returns the zero-based index or -1. Binary search with wildcards is not allowed (-2). */
export function xmatchIndex(lookup: FormulaScalar, vector: Vector, matchMode: MatchMode, searchMode: SearchMode): number {
  if (lookup === null || isError(lookup)) return -1;
  if (searchMode === 2 || searchMode === -2) {
    if (matchMode === 2) return -2;
    return binaryIndex(lookup, vector, matchMode, searchMode === -2);
  }
  const reverse = searchMode === -1;
  if (matchMode === 0 || matchMode === 2) return exactIndex(lookup, vector, matchMode === 2, reverse);
  return nearestIndex(lookup, vector, matchMode, reverse);
}
