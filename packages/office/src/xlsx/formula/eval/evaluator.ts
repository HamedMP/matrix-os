/**
 * The formula evaluator.
 *
 * Values: a number, text, a boolean, an error, blank (`null`), or an array.
 * A reference evaluates to an array with `ref` set: a cell is 1 by 1, a
 * range holds the used part of its bounds. Operators take the single value
 * of a one-cell reference and work element by element on larger arrays.
 *
 * Nothing here throws for a calculation problem. The bounds are:
 * - `maxDepth` (default 256): nesting of defined names and function calls;
 *   beyond it the result is `#NUM!`. A name that refers to itself ends there.
 * - `maxCells` (default 2 000 000): cells read from ranges (also those a
 *   function reads itself) plus cells of array results in one call of
 *   {@link evaluate}; beyond it `#NUM!`.
 */

import type {
  CellNode,
  CellProvider,
  EvalContext,
  FormulaAst,
  FormulaValue,
  FunctionContext,
  RangeBounds,
  RangeNode,
  RegisteredFunction,
} from "../../../api/formula.js";
import { ERR, broadcast, cellCount, isArray, isError, makeError, toScalar } from "../coerce.js";
import { sameSheet } from "../parser/a1.js";
import type { ExtendedAst, ExtendedCallNode, ReferenceOperatorNode, SheetSpanNode } from "../parser/ast.js";
import { acceptsRange } from "../registry.js";
import { applyBinary, applyUnary, type OperatorOptions } from "./operators.js";
import { boundsIntersection, boundsOfNode, boundsUnion, readReference } from "./reference.js";

/** Default for {@link EvaluateOptions.maxDepth}. */
export const DEFAULT_MAX_DEPTH = 256;
/** Default for {@link EvaluateOptions.maxCells}. */
export const DEFAULT_MAX_CELLS = 2_000_000;
/** Deepest nesting of syntax nodes the evaluator follows, across names and lazy functions. */
const MAX_NODE_DEPTH = 1024;

/** {@link EvalContext} with the bounds and extras of this engine. All are optional. */
export interface EvaluateOptions extends EvalContext {
  /** Most cells one evaluation may read and build before the result is `#NUM!`. Default 2 000 000. */
  maxCells?: number;
  /**
   * Sheet names in workbook order, for a reference across a span of sheets
   * (`Jan:Mar!B2`). Without it such a reference is `#REF!` unless both ends
   * name the same sheet.
   */
  sheetNames?: () => readonly string[];
}

interface State {
  readonly options: EvaluateOptions;
  readonly maxDepth: number;
  readonly maxCells: number;
  readonly operators: OperatorOptions;
  /** Current nesting of names and function calls. */
  depth: number;
  /** Current nesting of syntax nodes. */
  nodes: number;
  /** Cells read and built so far. */
  cells: number;
  /** The provider functions read through, which counts their reads; made on first use. */
  charged: CellProvider | null;
}

/** Where unqualified references point: the formula's sheet, or the sheet of the defined name being evaluated. */
interface Frame {
  readonly state: State;
  readonly sheet: string;
  context: FunctionContext | null;
}

const TOO_DEEP = "formula is nested too deeply";
const TOO_LARGE = "formula reads too many cells";

function charge(state: State, value: FormulaValue): FormulaValue {
  if (!isArray(value)) return value;
  state.cells += value.rows * value.cols;
  return state.cells > state.maxCells ? makeError("#NUM!", TOO_LARGE) : value;
}

/**
 * The provider handed to functions. A function that reads cells itself
 * (SUMIF's resized sum range, OFFSET, INDIRECT) is held to `maxCells` the
 * same way as a reference in the formula.
 */
function chargedProvider(state: State): CellProvider {
  if (state.charged !== null) return state.charged;
  const { provider } = state.options;
  state.charged = {
    getCellValue(sheet, row, col) {
      state.cells += 1;
      return state.cells > state.maxCells ? makeError("#NUM!", TOO_LARGE) : provider.getCellValue(sheet, row, col);
    },
    getRangeValues(bounds) {
      if (state.cells > state.maxCells) return makeError("#NUM!", TOO_LARGE);
      const values = provider.getRangeValues(bounds);
      if (isError(values)) return values;
      let cols = 0;
      for (const row of values) if (row.length > cols) cols = row.length;
      state.cells += values.length * cols;
      return state.cells > state.maxCells ? makeError("#NUM!", TOO_LARGE) : values;
    },
    resolveName: (name, sheet) => provider.resolveName(name, sheet),
  };
  return state.charged;
}

function sanitize(value: FormulaValue): FormulaValue {
  if (typeof value === "number") return Number.isFinite(value) ? value : ERR.NUM;
  return value === undefined ? null : value;
}

function functionContext(frame: Frame): FunctionContext {
  if (frame.context !== null) return frame.context;
  const { options } = frame.state;
  frame.context = {
    provider: chargedProvider(frame.state),
    sheet: frame.sheet,
    row: options.row,
    col: options.col,
    now: options.now ?? null,
    date1904: options.date1904 === true,
    random: options.random ?? Math.random,
    formatValue: options.formatValue ?? null,
    evaluate: (node: FormulaAst) => evalNode(node, frame),
  };
  return frame.context;
}

function readBounds(bounds: RangeBounds, frame: Frame): FormulaValue {
  if (frame.state.cells > frame.state.maxCells) return makeError("#NUM!", TOO_LARGE);
  return charge(frame.state, readReference(frame.state.options.provider, bounds));
}

function evalName(name: string, sheet: string | null, frame: Frame): FormulaValue {
  const { state } = frame;
  const resolution = state.options.provider.resolveName(name, sheet ?? frame.sheet);
  if (resolution === null) return makeError("#NAME?", "unknown name");
  if (resolution.kind === "value") return charge(state, resolution.value);
  if (state.depth >= state.maxDepth) return makeError("#NUM!", TOO_DEEP);
  state.depth += 1;
  try {
    return evalNode(resolution.ast, { state, sheet: resolution.sheet, context: null });
  } finally {
    state.depth -= 1;
  }
}

/** The bounds of an operand of a reference operator, or the error to return instead. */
function operandBounds(node: ExtendedAst, frame: Frame): RangeBounds | FormulaValue {
  const value = evalNode(node, frame);
  if (isArray(value) && value.ref !== null) return value.ref;
  if (isError(value)) return value;
  return makeError("#VALUE!", "a reference operator needs references");
}

function isBounds(value: RangeBounds | FormulaValue): value is RangeBounds {
  return typeof value === "object" && value !== null && !("kind" in value);
}

function evalReferenceOperator(node: ReferenceOperatorNode, frame: Frame): FormulaValue {
  if (node.op === ",") return makeError("#VALUE!", "a union is only allowed as a function argument");
  const left = operandBounds(node.left, frame);
  if (!isBounds(left)) return left;
  const right = operandBounds(node.right, frame);
  if (!isBounds(right)) return right;
  if (node.op === ":") {
    const joined = boundsUnion(left, right);
    return joined === null ? makeError("#VALUE!", "a range cannot span two sheets") : readBounds(joined, frame);
  }
  const common = boundsIntersection(left, right);
  return common === null ? ERR.NULL : readBounds(common, frame);
}

/** The sheets of a span in workbook order, or null when they cannot be listed. */
function spanSheets(node: SheetSpanNode, frame: Frame): string[] | null {
  if (sameSheet(node.startSheet, node.endSheet)) return [node.startSheet];
  const names = frame.state.options.sheetNames?.();
  if (names === undefined) return null;
  const first = names.findIndex((name) => sameSheet(name, node.startSheet));
  const last = names.findIndex((name) => sameSheet(name, node.endSheet));
  if (first === -1 || last === -1) return null;
  return names.slice(Math.min(first, last), Math.max(first, last) + 1);
}

/**
 * Spreads unions and sheet spans over several arguments, so that
 * `SUM((A1:A3,C1:C3))` and `SUM(Jan:Mar!B2)` reach the function as one
 * argument per area. Returns null when a span cannot be resolved.
 */
function expandArguments(args: readonly ExtendedAst[], frame: Frame): ExtendedAst[] | null {
  let out: ExtendedAst[] | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as ExtendedAst;
    let inner = arg;
    while (inner.type === "paren") inner = inner.inner;
    const spreads = inner.type === "ref3d" || (inner.type === "refop" && inner.op === ",");
    if (!spreads) {
      if (out !== null) out.push(arg);
      continue;
    }
    if (out === null) out = args.slice(0, i);
    const pending: ExtendedAst[] = [inner];
    while (pending.length > 0) {
      let part = pending.pop() as ExtendedAst;
      while (part.type === "paren") part = part.inner;
      if (part.type === "refop" && part.op === ",") {
        pending.push(part.right, part.left);
      } else if (part.type === "ref3d") {
        const sheets = spanSheets(part, frame);
        if (sheets === null) return null;
        for (const sheet of sheets) out.push({ ...part.ref, sheet } as CellNode | RangeNode);
      } else {
        out.push(part);
      }
    }
  }
  return out ?? (args as ExtendedAst[]);
}

function callEager(fn: RegisteredFunction & { lazy: false }, values: FormulaValue[], frame: Frame): FormulaValue {
  const context = functionContext(frame);
  let lifted: number[] | null = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] as FormulaValue;
    if (!isArray(value) || acceptsRange(fn, i)) continue;
    if (cellCount(value) <= 1) values[i] = toScalar(value);
    else (lifted ??= []).push(i);
  }
  if (lifted === null) return fn.impl(values, context);
  const positions = lifted;
  const arrays = positions.map((position) => values[position] as FormulaValue);
  const remaining = Math.max(0, frame.state.maxCells - frame.state.cells);
  return broadcast(
    arrays,
    (scalars) => {
      for (let k = 0; k < positions.length; k += 1) values[positions[k] as number] = scalars[k] ?? null;
      return toScalar(sanitize(fn.impl(values, context)));
    },
    remaining,
  );
}

function evalCall(node: ExtendedCallNode, frame: Frame): FormulaValue {
  const { state } = frame;
  const fn = state.options.functions.get(node.name);
  if (fn === null) return makeError("#NAME?", "unknown function");
  const args = expandArguments(node.args, frame);
  if (args === null) return makeError("#REF!", "the sheets of a reference across sheets are not known");
  if (args.length < fn.minArgs || (fn.maxArgs !== null && args.length > fn.maxArgs)) {
    return makeError("#VALUE!", "wrong number of arguments");
  }
  if (state.depth >= state.maxDepth) return makeError("#NUM!", TOO_DEEP);
  state.depth += 1;
  try {
    if (fn.lazy) return charge(state, sanitize(fn.impl(args as FormulaAst[], functionContext(frame))));
    const values: FormulaValue[] = new Array<FormulaValue>(args.length);
    for (let i = 0; i < args.length; i += 1) values[i] = evalNode(args[i] as ExtendedAst, frame);
    return charge(state, sanitize(callEager(fn, values, frame)));
  } finally {
    state.depth -= 1;
  }
}

/** A chain of binary operators (`a+b+c+…`) leans left; it is folded in a loop so that its length costs no stack. */
function evalBinaryChain(node: ExtendedAst, frame: Frame): FormulaValue {
  const spine: Array<Extract<ExtendedAst, { type: "binary" }>> = [];
  let current = node;
  while (current.type === "binary") {
    spine.push(current);
    current = current.left;
  }
  const { state } = frame;
  let value = evalNode(current, frame);
  for (let i = spine.length - 1; i >= 0; i -= 1) {
    const step = spine[i] as Extract<ExtendedAst, { type: "binary" }>;
    const right = evalNode(step.right, frame);
    state.operators.maxCells = Math.max(0, state.maxCells - state.cells);
    value = charge(state, applyBinary(step.op, value, right, state.operators));
  }
  return value;
}

function evalNode(node: ExtendedAst, frame: Frame): FormulaValue {
  const { state } = frame;
  if (state.nodes >= MAX_NODE_DEPTH) return makeError("#NUM!", TOO_DEEP);
  state.nodes += 1;
  try {
    let current = node;
    while (current.type === "paren") current = current.inner;
    switch (current.type) {
      case "number":
      case "string":
      case "boolean":
        return current.value;
      case "error":
        return makeError(current.code);
      case "missing":
        return null;
      case "cell":
      case "range":
        return readBounds(boundsOfNode(current, frame.sheet), frame);
      case "name":
        return evalName(current.name, current.sheet, frame);
      case "unary": {
        const operand = evalNode(current.operand, frame);
        state.operators.maxCells = Math.max(0, state.maxCells - state.cells);
        return charge(state, applyUnary(current.op, operand, state.operators));
      }
      case "binary":
        return evalBinaryChain(current, frame);
      case "call":
        return evalCall(current, frame);
      case "array": {
        const values = current.rows.map((row) => row.map((cell) => toScalar(evalNode(cell, frame))));
        return charge(state, { kind: "array", rows: values.length, cols: values[0]?.length ?? 0, values, ref: null });
      }
      case "refop":
        return evalReferenceOperator(current, frame);
      case "ref3d": {
        const sheets = spanSheets(current, frame);
        if (sheets === null) return makeError("#REF!", "the sheets of a reference across sheets are not known");
        if (sheets.length !== 1) return makeError("#VALUE!", "a reference across sheets is only allowed as a function argument");
        return readBounds(boundsOfNode(current.ref, sheets[0] as string), frame);
      }
    }
  } finally {
    state.nodes -= 1;
  }
}

/**
 * Evaluates a formula.
 *
 * Never throws for a calculation problem: division by zero, a wrong type,
 * an unknown name or function, too deep or too large an evaluation are
 * error values. A reference result is a `FormulaArray` with `ref` set (a
 * single cell too); `toCellResult` picks the value a cell shows.
 *
 * Accepts the contract tree and the extended tree. A function that throws
 * a `RangeError` (a stack that ran out, an impossible length) gives `#NUM!`;
 * any other exception is a defect in that function and is passed on.
 */
export function evaluate(ast: ExtendedAst, context: EvaluateOptions): FormulaValue {
  const state: State = {
    options: context,
    maxDepth: context.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxCells: context.maxCells ?? DEFAULT_MAX_CELLS,
    operators: { date1904: context.date1904 === true },
    depth: 0,
    nodes: 0,
    cells: 0,
    charged: null,
  };
  try {
    return sanitize(evalNode(ast, { state, sheet: context.sheet, context: null }));
  } catch (error) {
    // A stack that ran out or an impossible length inside a function: a calculation limit, not a defect.
    if (error instanceof RangeError) return makeError("#NUM!", "evaluation ran out of room");
    throw error;
  }
}
