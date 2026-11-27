/**
 * Reference functions: INDEX, CHOOSE, OFFSET, INDIRECT, ROW, COLUMN, ROWS
 * and COLUMNS. INDEX and OFFSET return references, so their result can be
 * summed, counted or used as one end of a range.
 */

import type {
  FormulaArg,
  FormulaAst,
  FormulaError,
  FormulaScalar,
  FormulaValue,
  FunctionContext,
  FunctionRegistry,
  RangeBounds,
} from "../../../../api/formula.js";
import { isOfficeError } from "../../../../errors.js";
import { ERR, asArray, broadcast, cellCount, isArray, isError, makeArray, toNumber, toScalar } from "../../coerce.js";
import { boundsOfNode, readReference, writtenBounds } from "../../eval/reference.js";
import { parseFormula } from "../../parser/parser.js";
import { registerFunction, registerLazyFunction } from "../../registry.js";
import { boolArg, intArg, textArg } from "../text/args.js";
import { shapeOf } from "./match.js";
import { sliceArray } from "./slice.js";

/** Longest reference text INDIRECT reads. */
const MAX_REFERENCE_TEXT = 1024;

function index(args: readonly FormulaArg[]): FormulaValue {
  const source = args[0] ?? null;
  if (isError(source)) return source;
  const array = asArray(source);
  const shape = shapeOf(array);
  let row = intArg(args[1], 0);
  if (isError(row)) return row;
  let col: number;
  if (args.length < 3) {
    col = 0;
    if (shape.rows === 1 && shape.cols > 1) {
      col = row;
      row = 1;
    } else if (shape.cols === 1) {
      col = 1;
    }
  } else {
    const given = intArg(args[2], 0);
    if (isError(given)) return given;
    col = given;
  }
  const area = intArg(args[3], 1);
  if (isError(area)) return area;
  if (area !== 1) return ERR.REF;
  if (row < 0 || col < 0) return ERR.VALUE;
  if (row > shape.rows || col > shape.cols) return ERR.REF;
  const [r0, r1] = row === 0 ? [0, shape.rows - 1] : [row - 1, row - 1];
  const [c0, c1] = col === 0 ? [0, shape.cols - 1] : [col - 1, col - 1];
  if (r1 < r0 || c1 < c0) return ERR.REF;
  return sliceArray(array, r0, c0, r1, c1);
}

function choose(args: readonly FormulaAst[], context: FunctionContext): FormulaValue {
  const selector = context.evaluate(args[0] as FormulaAst);
  const choices = args.length - 1;
  if (isArray(selector) && cellCount(selector) > 1) {
    const values = args.slice(1).map((node) => context.evaluate(node));
    return broadcast([selector, ...values], (scalars) => {
      const n = toNumber(scalars[0] as FormulaScalar);
      if (isError(n)) return n;
      const k = Math.trunc(n);
      return k < 1 || k > choices ? ERR.VALUE : (scalars[k] ?? null);
    });
  }
  const n = toNumber(toScalar(selector));
  if (isError(n)) return n;
  const k = Math.trunc(n);
  if (k < 1 || k > choices) return ERR.VALUE;
  return context.evaluate(args[k] as FormulaAst);
}

/** A lazy argument as a whole number, or `fallback` when it is absent or empty. */
function lazyInt(node: FormulaAst | undefined, context: FunctionContext, fallback: number): number | FormulaError {
  if (node === undefined) return fallback;
  return intArg(toScalar(context.evaluate(node)), fallback);
}

/**
 * The bounds a reference argument points at, or the error to return. A
 * reference written in the formula is not read: only where it points counts.
 */
function referenceArg(node: FormulaAst, context: FunctionContext): RangeBounds | FormulaError {
  const written = writtenBounds(node, context.provider, context.sheet);
  if (written !== null) return written;
  const value = context.evaluate(node);
  if (isError(value)) return value;
  return isArray(value) && value.ref !== null ? value.ref : ERR.VALUE;
}

function offset(args: readonly FormulaAst[], context: FunctionContext): FormulaValue {
  const ref = referenceArg(args[0] as FormulaAst, context);
  if (isError(ref)) return ref;
  const rows = lazyInt(args[1], context, 0);
  if (isError(rows)) return rows;
  const cols = lazyInt(args[2], context, 0);
  if (isError(cols)) return cols;
  const height = lazyInt(args[3], context, ref.endRow - ref.startRow + 1);
  if (isError(height)) return height;
  const width = lazyInt(args[4], context, ref.endCol - ref.startCol + 1);
  if (isError(width)) return width;
  if (height < 1 || width < 1) return ERR.REF;
  const bounds: RangeBounds = {
    sheet: ref.sheet,
    startRow: ref.startRow + rows,
    startCol: ref.startCol + cols,
    endRow: ref.startRow + rows + height - 1,
    endCol: ref.startCol + cols + width - 1,
  };
  return readReference(context.provider, bounds);
}

function indirect(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const text = textArg(args[0]);
  if (isError(text)) return text;
  const a1 = boolArg(args[1], true);
  if (isError(a1)) return a1;
  const trimmed = text.trim();
  if (!a1 || trimmed === "" || trimmed.length > MAX_REFERENCE_TEXT) return ERR.REF;
  let ast: FormulaAst;
  try {
    ast = parseFormula(trimmed.startsWith("=") ? trimmed.slice(1) : trimmed);
  } catch (error) {
    if (isOfficeError(error)) return ERR.REF;
    throw error;
  }
  if (ast.type === "cell" || ast.type === "range") return readReference(context.provider, boundsOfNode(ast, context.sheet));
  if (ast.type === "name") {
    const value = context.evaluate(ast);
    if (isError(value)) return value;
    return isArray(value) && value.ref !== null ? value : ERR.REF;
  }
  return ERR.REF;
}

function position(vertical: boolean): (args: readonly FormulaAst[], context: FunctionContext) => FormulaValue {
  return (args, context) => {
    if (args.length === 0) return vertical ? context.row + 1 : context.col + 1;
    const ref = referenceArg(args[0] as FormulaAst, context);
    if (isError(ref)) return ref;
    const first = vertical ? ref.startRow : ref.startCol;
    const last = vertical ? ref.endRow : ref.endCol;
    if (first === last) return first + 1;
    const numbers: number[] = [];
    for (let n = first; n <= last; n += 1) numbers.push(n + 1);
    return vertical ? makeArray(numbers.map((n) => [n])) : makeArray([numbers]);
  };
}

function size(vertical: boolean): (args: readonly FormulaAst[], context: FunctionContext) => FormulaValue {
  return (args, context) => {
    const node = args[0] as FormulaAst;
    const written = writtenBounds(node, context.provider, context.sheet);
    if (written !== null) return vertical ? written.endRow - written.startRow + 1 : written.endCol - written.startCol + 1;
    const value = context.evaluate(node);
    if (isError(value)) return value;
    if (!isArray(value)) return 1;
    const shape = shapeOf(value);
    return vertical ? shape.rows : shape.cols;
  };
}

/** Registers INDEX, CHOOSE, OFFSET, INDIRECT, ROW, COLUMN, ROWS and COLUMNS. */
export function registerReferenceFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "INDEX", index, { minArgs: 2, maxArgs: 4, ranges: [0] });
  registerLazyFunction(registry, "CHOOSE", choose, { minArgs: 2, maxArgs: 255 });
  registerLazyFunction(registry, "OFFSET", offset, { minArgs: 3, maxArgs: 5, volatile: true });
  registerFunction(registry, "INDIRECT", indirect, { minArgs: 1, maxArgs: 2, volatile: true, ranges: "none" });
  registerLazyFunction(registry, "ROW", position(true), { minArgs: 0, maxArgs: 1 });
  registerLazyFunction(registry, "COLUMN", position(false), { minArgs: 0, maxArgs: 1 });
  registerLazyFunction(registry, "ROWS", size(true), { minArgs: 1, maxArgs: 1 });
  registerLazyFunction(registry, "COLUMNS", size(false), { minArgs: 1, maxArgs: 1 });
}
