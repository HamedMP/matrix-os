/**
 * Functions that return arrays: TRANSPOSE, UNIQUE, SORT and FILTER.
 *
 * A small reference (up to {@link MATERIALIZE_LIMIT} cells) is read at its
 * full size, blanks included; a larger one (a whole column) only over the
 * used part of the sheet. FILTER accepts an include array that is shorter
 * than the data when it was computed from the used part of a range; the
 * missing entries count as FALSE. An empty result has no error code of its
 * own here, so it is `#VALUE!` with a message.
 */

import type { FormulaArg, FormulaError, FormulaScalar, FormulaValue, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, asArray, compareValues, flattenValues, isArray, isError, makeArray, makeError, toBoolean, toNumber } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { boolArg } from "../text/args.js";
import { materialize } from "./slice.js";

const EMPTY_RESULT = "the result is empty";

function transposeRows(rows: FormulaScalar[][]): FormulaScalar[][] {
  const cols = rows.length === 0 ? 0 : (rows[0] as FormulaScalar[]).length;
  const out: FormulaScalar[][] = [];
  for (let c = 0; c < cols; c += 1) out.push(rows.map((row) => row[c] as FormulaScalar));
  return out;
}

function transpose(args: readonly FormulaArg[]): FormulaValue {
  const value = args[0] ?? null;
  if (!isArray(value)) return value;
  const rows = materialize(value);
  if (rows.length === 0) return makeError("#VALUE!", EMPTY_RESULT);
  return makeArray(transposeRows(rows));
}

/** Items (rows, or columns when `byCol`) of an array argument. */
function itemsOf(value: FormulaValue, byCol: boolean): FormulaScalar[][] {
  const rows = materialize(asArray(value));
  return byCol ? transposeRows(rows) : rows;
}

function result(items: FormulaScalar[][], byCol: boolean): FormulaValue {
  if (items.length === 0 || (items[0] as FormulaScalar[]).length === 0) return makeError("#VALUE!", EMPTY_RESULT);
  return makeArray(byCol ? transposeRows(items) : items);
}

function cellKey(cell: FormulaScalar): string {
  if (cell === null) return "z";
  if (typeof cell === "number") return `n${cell === 0 ? 0 : cell}`;
  if (typeof cell === "string") return `s${cell.toUpperCase()}`;
  if (typeof cell === "boolean") return cell ? "bT" : "bF";
  return `e${cell.code}`;
}

function unique(args: readonly FormulaArg[]): FormulaValue {
  const source = args[0] ?? null;
  if (isError(source)) return source;
  const byCol = boolArg(args[1], false);
  if (isError(byCol)) return byCol;
  const exactlyOnce = boolArg(args[2], false);
  if (isError(exactlyOnce)) return exactlyOnce;
  const items = itemsOf(source, byCol);
  // Bounded by the number of items of the argument.
  const counts = new Map<string, { item: FormulaScalar[]; count: number }>();
  for (const item of items) {
    const key = item.map(cellKey).join("\u0000");
    const seen = counts.get(key);
    if (seen === undefined) counts.set(key, { item, count: 1 });
    else seen.count += 1;
  }
  const kept: FormulaScalar[][] = [];
  for (const { item, count } of counts.values()) if (!exactlyOnce || count === 1) kept.push(item);
  return result(kept, byCol);
}

/** Whole numbers of an argument that may be a scalar or an array. */
function integerList(value: FormulaValue | undefined, fallback: number): number[] | FormulaError {
  if (value === undefined || value === null) return [fallback];
  const out: number[] = [];
  for (const cell of flattenValues(value)) {
    const n = toNumber(cell);
    if (isError(n)) return n;
    out.push(Math.trunc(n));
  }
  return out;
}

function sort(args: readonly FormulaArg[]): FormulaValue {
  const source = args[0] ?? null;
  if (isError(source)) return source;
  const keys = integerList(args[1], 1);
  if (isError(keys)) return keys;
  const orders = integerList(args[2], 1);
  if (isError(orders)) return orders;
  const byCol = boolArg(args[3], false);
  if (isError(byCol)) return byCol;
  const items = itemsOf(source, byCol);
  const width = items.length === 0 ? 0 : (items[0] as FormulaScalar[]).length;
  if (orders.length !== 1 && orders.length !== keys.length) return ERR.VALUE;
  for (const key of keys) if (key < 1 || key > width) return ERR.VALUE;
  for (const order of orders) if (order !== 1 && order !== -1) return ERR.VALUE;
  const sorted = [...items].sort((a, b) => {
    for (let k = 0; k < keys.length; k += 1) {
      const col = (keys[k] as number) - 1;
      const order = compareValues(a[col] as FormulaScalar, b[col] as FormulaScalar);
      if (order !== 0) return order * ((orders.length === 1 ? orders[0] : orders[k]) as number);
    }
    return 0;
  });
  return result(sorted, byCol);
}

function filter(args: readonly FormulaArg[]): FormulaValue {
  const source = args[0] ?? null;
  if (isError(source)) return source;
  const includeArg = args[1] ?? null;
  if (isError(includeArg)) return includeArg;
  const rows = materialize(asArray(source));
  const include = materialize(asArray(includeArg));
  const dataRows = rows.length;
  const dataCols = dataRows === 0 ? 0 : (rows[0] as FormulaScalar[]).length;
  const includeRows = include.length;
  const includeCols = includeRows === 0 ? 0 : (include[0] as FormulaScalar[]).length;
  let byCol: boolean;
  if (includeCols === 1 && includeRows <= dataRows && (includeRows > 1 || dataCols === 1 || dataRows === 1)) byCol = false;
  else if (includeRows === 1 && includeCols <= dataCols) byCol = true;
  else return makeError("#VALUE!", "the include array does not fit the data");
  const flags = byCol ? (include[0] as FormulaScalar[]) : include.map((row) => row[0] as FormulaScalar);
  const items = byCol ? transposeRows(rows) : rows;
  const kept: FormulaScalar[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const flag = i < flags.length ? toBoolean(flags[i] as FormulaScalar) : false;
    if (isError(flag)) return flag;
    if (flag) kept.push(items[i] as FormulaScalar[]);
  }
  if (kept.length === 0) {
    if (args[2] !== undefined && args[2] !== null) return args[2];
    return makeError("#VALUE!", EMPTY_RESULT);
  }
  return result(kept, byCol);
}

/** Registers TRANSPOSE, UNIQUE, SORT and FILTER. */
export function registerArrayFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "TRANSPOSE", transpose, { minArgs: 1, maxArgs: 1 });
  registerFunction(registry, "UNIQUE", unique, { minArgs: 1, maxArgs: 3, ranges: [0] });
  registerFunction(registry, "SORT", sort, { minArgs: 1, maxArgs: 4, ranges: [0, 1, 2] });
  registerFunction(registry, "FILTER", filter, { minArgs: 2, maxArgs: 3 });
}
