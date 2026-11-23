/**
 * Search functions: VLOOKUP, HLOOKUP, LOOKUP, MATCH, XMATCH and XLOOKUP.
 * Match rules live in `match.ts`.
 */

import type { FormulaArg, FormulaArray, FormulaError, FormulaScalar, FormulaValue, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, asArray, isError, makeError, toBoolean, toScalar } from "../../coerce.js";
import { valueAt } from "../../eval/reference.js";
import { registerFunction } from "../../registry.js";
import { intArg, isMissing } from "../text/args.js";
import {
  type MatchMode,
  type SearchMode,
  approximateIndex,
  columnVector,
  exactIndex,
  rowVector,
  shapeOf,
  vectorOf,
  xmatchIndex,
} from "./match.js";
import { sliceArray } from "./slice.js";

function lookupValue(arg: FormulaArg | undefined): FormulaScalar {
  return toScalar(arg ?? null);
}

/** The table argument as an array, or the error it holds. */
function tableArg(arg: FormulaArg | undefined): FormulaArray | FormulaError {
  const value = arg ?? null;
  if (isError(value)) return value;
  return asArray(value);
}

function tableLookup(horizontal: boolean): (args: readonly FormulaArg[]) => FormulaValue {
  return (args) => {
    const lookup = lookupValue(args[0]);
    if (isError(lookup)) return lookup;
    const table = tableArg(args[1]);
    if (isError(table)) return table;
    const index = intArg(args[2]);
    if (isError(index)) return index;
    // Omitted is approximate; left empty (`VLOOKUP(x,t,2,)`) is FALSE, an exact match.
    const approximate = args[3] === undefined ? true : toBoolean(args[3]);
    if (isError(approximate)) return approximate;
    const shape = shapeOf(table);
    if (index < 1) return ERR.VALUE;
    if (index > (horizontal ? shape.rows : shape.cols)) return ERR.REF;
    const vector = horizontal ? rowVector(table, 0) : columnVector(table, 0);
    const found = approximate ? approximateIndex(lookup, vector) : exactIndex(lookup, vector, true);
    if (found < 0) return ERR.NA;
    return horizontal ? valueAt(table, index - 1, found) : valueAt(table, found, index - 1);
  };
}

function lookup(args: readonly FormulaArg[]): FormulaValue {
  const value = lookupValue(args[0]);
  if (isError(value)) return value;
  const table = tableArg(args[1]);
  if (isError(table)) return table;
  if (args.length >= 3) {
    const searched = vectorOf(table);
    if (searched === null) return ERR.NA;
    const results = tableArg(args[2]);
    if (isError(results)) return results;
    const target = vectorOf(results);
    if (target === null) return ERR.NA;
    const found = approximateIndex(value, searched.vector);
    if (found < 0) return ERR.NA;
    const length = target.horizontal ? shapeOf(results).cols : shapeOf(results).rows;
    if (found >= length) return ERR.NA;
    return target.horizontal ? valueAt(results, 0, found) : valueAt(results, found, 0);
  }
  const shape = shapeOf(table);
  const horizontal = shape.cols > shape.rows;
  const found = approximateIndex(value, horizontal ? rowVector(table, 0) : columnVector(table, 0));
  if (found < 0) return ERR.NA;
  return horizontal ? valueAt(table, shape.rows - 1, found) : valueAt(table, found, shape.cols - 1);
}

function match(args: readonly FormulaArg[]): FormulaValue {
  const value = lookupValue(args[0]);
  if (isError(value)) return value;
  const table = tableArg(args[1]);
  if (isError(table)) return table;
  // Omitted is 1; left empty (`MATCH(x,r,)`) is 0, an exact match.
  const type = args[2] === undefined ? 1 : intArg(args[2]);
  if (isError(type)) return type;
  const view = vectorOf(table);
  if (view === null) return ERR.NA;
  let found: number;
  if (type === 0) found = exactIndex(value, view.vector, true);
  else found = approximateIndex(value, view.vector, type < 0);
  return found < 0 ? ERR.NA : found + 1;
}

function modes(matchArg: FormulaArg | undefined, searchArg: FormulaArg | undefined): { match: MatchMode; search: SearchMode } | null {
  const matchMode = intArg(matchArg, 0);
  const searchMode = intArg(searchArg, 1);
  if (isError(matchMode) || isError(searchMode)) return null;
  if (![0, -1, 1, 2].includes(matchMode) || ![1, -1, 2, -2].includes(searchMode)) return null;
  return { match: matchMode as MatchMode, search: searchMode as SearchMode };
}

function modeError(matchArg: FormulaArg | undefined, searchArg: FormulaArg | undefined): FormulaValue {
  const a = intArg(matchArg, 0);
  if (isError(a)) return a;
  const b = intArg(searchArg, 1);
  return isError(b) ? b : ERR.VALUE;
}

function xmatch(args: readonly FormulaArg[]): FormulaValue {
  const value = lookupValue(args[0]);
  if (isError(value)) return value;
  const table = tableArg(args[1]);
  if (isError(table)) return table;
  const mode = modes(args[2], args[3]);
  if (mode === null) return modeError(args[2], args[3]);
  const view = vectorOf(table);
  if (view === null) return ERR.VALUE;
  const found = xmatchIndex(value, view.vector, mode.match, mode.search);
  if (found === -2) return ERR.VALUE;
  return found < 0 ? ERR.NA : found + 1;
}

function xlookup(args: readonly FormulaArg[]): FormulaValue {
  const value = lookupValue(args[0]);
  if (isError(value)) return value;
  const table = tableArg(args[1]);
  if (isError(table)) return table;
  const results = tableArg(args[2]);
  if (isError(results)) return results;
  const mode = modes(args[4], args[5]);
  if (mode === null) return modeError(args[4], args[5]);
  const view = vectorOf(table);
  if (view === null) return ERR.VALUE;
  const lookupShape = shapeOf(table);
  const resultShape = shapeOf(results);
  const length = view.horizontal ? lookupShape.cols : lookupShape.rows;
  if ((view.horizontal ? resultShape.cols : resultShape.rows) !== length) {
    return makeError("#VALUE!", "the lookup and return arrays differ in size");
  }
  const found = xmatchIndex(value, view.vector, mode.match, mode.search);
  if (found === -2) return ERR.VALUE;
  if (found < 0) return isMissing(args[3]) ? ERR.NA : (args[3] as FormulaValue);
  return view.horizontal
    ? sliceArray(results, 0, found, resultShape.rows - 1, found)
    : sliceArray(results, found, 0, found, resultShape.cols - 1);
}

/** Registers VLOOKUP, HLOOKUP, LOOKUP, MATCH, XMATCH and XLOOKUP. */
export function registerSearchFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "VLOOKUP", tableLookup(false), { minArgs: 3, maxArgs: 4, ranges: [1] });
  registerFunction(registry, "HLOOKUP", tableLookup(true), { minArgs: 3, maxArgs: 4, ranges: [1] });
  registerFunction(registry, "LOOKUP", lookup, { minArgs: 2, maxArgs: 3, ranges: [1, 2] });
  registerFunction(registry, "MATCH", match, { minArgs: 2, maxArgs: 3, ranges: [1] });
  registerFunction(registry, "XMATCH", xmatch, { minArgs: 2, maxArgs: 4, ranges: [1] });
  registerFunction(registry, "XLOOKUP", xlookup, { minArgs: 3, maxArgs: 6, ranges: [1, 2, 3] });
}
