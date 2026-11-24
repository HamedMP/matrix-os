/**
 * Aggregates over the cells that meet criteria: COUNTIF, COUNTIFS, SUMIF,
 * SUMIFS, AVERAGEIF, AVERAGEIFS, MAXIFS and MINIFS. The criteria rules are
 * in `criteria.ts`.
 *
 * Shapes: in the *IFS forms every range must have the same number of rows
 * and columns (`#VALUE!` otherwise). SUMIF and AVERAGEIF take the size of
 * the criteria range and start the sum range at its top-left cell.
 *
 * Errors: an error in a criteria range only matches an error criterion; an
 * error in the sum, average, max or min range is the result when its row
 * matches. A criterion that is an array gives an array of results.
 */

import type {
  FormulaError,
  FormulaScalar,
  FormulaValue,
  FunctionContext,
  FunctionRegistry,
} from "../../../../api/formula.js";
import { ERR, isError, toScalar } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { parseCriterion, type Criterion } from "./criteria.js";
import { gridOf, resizedGrid, sameShape, usedRegion, type Grid } from "./grid.js";

interface Condition {
  grid: Grid;
  test: Criterion;
}

/** Visits every position of the used region where all conditions hold. */
function eachMatch(conditions: readonly Condition[], grids: readonly Grid[], visit: (row: number, col: number) => FormulaError | void): FormulaError | null {
  const region = usedRegion(grids);
  for (let row = 0; row < region.rows; row += 1) {
    for (let col = 0; col < region.cols; col += 1) {
      if (!conditions.every(({ grid, test }) => test(grid.at(row, col)))) continue;
      const failure = visit(row, col);
      if (failure !== undefined) return failure;
    }
  }
  return null;
}

/** Number of positions outside the used region where every condition holds (all cells there are blank). */
function blankMatches(conditions: readonly Condition[], grids: readonly Grid[]): number {
  const first = grids[0];
  if (first === undefined || !conditions.every(({ test }) => test(null))) return 0;
  const region = usedRegion(grids);
  return first.rows * first.cols - region.rows * region.cols;
}

/** Pairs of (range, criterion) arguments from `start`, or an error for a bad shape or count. */
function conditionsOf(args: readonly FormulaValue[], start: number, context: FunctionContext): Condition[] | FormulaError {
  if ((args.length - start) % 2 !== 0 || args.length - start < 2) return ERR.VALUE;
  const out: Condition[] = [];
  for (let i = start; i < args.length; i += 2) {
    const range = args[i] ?? null;
    if (isError(range)) return range;
    const criterion = toScalar(args[i + 1] ?? null);
    out.push({ grid: gridOf(range), test: parseCriterion(criterion, { date1904: context.date1904 }) });
  }
  return out;
}

type Reducer = { add(value: number): void; result(): FormulaValue };

function sumReducer(): Reducer {
  let sum = 0;
  return { add: (n) => (sum += n), result: () => sum };
}

function averageReducer(): Reducer {
  let sum = 0;
  let count = 0;
  return {
    add: (n) => {
      sum += n;
      count += 1;
    },
    result: () => (count === 0 ? ERR.DIV0 : sum / count),
  };
}

function extremeReducer(largest: boolean): Reducer {
  let best: number | null = null;
  return {
    add: (n) => {
      if (best === null || (largest ? n > best : n < best)) best = n;
    },
    result: () => best ?? 0,
  };
}

/** Feeds the numbers of `target` at matching positions to the reducer. */
function reduceMatches(target: Grid, conditions: Condition[], reducer: Reducer): FormulaValue {
  const grids = [target, ...conditions.map((c) => c.grid)];
  const failure = eachMatch(conditions, grids, (row, col) => {
    const cell = target.at(row, col);
    if (typeof cell === "number") reducer.add(cell);
    else if (isError(cell)) return cell;
    return undefined;
  });
  return failure ?? reducer.result();
}

/** SUMIF and AVERAGEIF: `(range, criterion, [target])`. */
function singleCondition(makeReducer: () => Reducer) {
  return (args: readonly FormulaValue[], context: FunctionContext): FormulaValue => {
    if (isError(args[0])) return args[0];
    if (isError(args[2])) return args[2];
    const range = gridOf(args[0] ?? null);
    const test = parseCriterion(toScalar(args[1] ?? null), { date1904: context.date1904 });
    const source = args.length > 2 && args[2] !== null ? (args[2] as FormulaValue) : (args[0] ?? null);
    const target = resizedGrid(source, range.rows, range.cols, context.provider);
    if (isError(target)) return target;
    return reduceMatches(target, [{ grid: range, test }], makeReducer());
  };
}

/** SUMIFS, AVERAGEIFS, MAXIFS, MINIFS: `(target, range1, criterion1, ...)`. */
function multiCondition(makeReducer: () => Reducer) {
  return (args: readonly FormulaValue[], context: FunctionContext): FormulaValue => {
    if (isError(args[0])) return args[0];
    const conditions = conditionsOf(args, 1, context);
    if (isError(conditions)) return conditions;
    const target = gridOf(args[0] ?? null);
    if (!sameShape([target, ...conditions.map((c) => c.grid)])) return ERR.VALUE;
    return reduceMatches(target, conditions, makeReducer());
  };
}

function countMatches(conditions: Condition[]): FormulaValue {
  const grids = conditions.map((c) => c.grid);
  if (!sameShape(grids)) return ERR.VALUE;
  let count = 0;
  eachMatch(conditions, grids, () => {
    count += 1;
  });
  return count + blankMatches(conditions, grids);
}

function countIf(args: readonly FormulaValue[], context: FunctionContext): FormulaValue {
  if (isError(args[0])) return args[0];
  const criterion: FormulaScalar = toScalar(args[1] ?? null);
  return countMatches([{ grid: gridOf(args[0] ?? null), test: parseCriterion(criterion, { date1904: context.date1904 }) }]);
}

function countIfs(args: readonly FormulaValue[], context: FunctionContext): FormulaValue {
  const conditions = conditionsOf(args, 0, context);
  return isError(conditions) ? conditions : countMatches(conditions);
}

/** Ranges at even positions: `(range1, criterion1, range2, criterion2, ...)`. */
const EVEN = (i: number): boolean => i % 2 === 0;
/** Target first, then ranges at odd positions: `(target, range1, criterion1, ...)`. */
const TARGET_THEN_ODD = (i: number): boolean => i === 0 || i % 2 === 1;

export function registerConditionalFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "COUNTIF", countIf, { minArgs: 2, maxArgs: 2, ranges: [0] });
  registerFunction(registry, "COUNTIFS", countIfs, { minArgs: 2, maxArgs: 254, ranges: EVEN });
  registerFunction(registry, "SUMIF", singleCondition(sumReducer), { minArgs: 2, maxArgs: 3, ranges: [0, 2] });
  registerFunction(registry, "SUMIFS", multiCondition(sumReducer), { minArgs: 3, maxArgs: 255, ranges: TARGET_THEN_ODD });
  registerFunction(registry, "AVERAGEIF", singleCondition(averageReducer), { minArgs: 2, maxArgs: 3, ranges: [0, 2] });
  registerFunction(registry, "AVERAGEIFS", multiCondition(averageReducer), {
    minArgs: 3,
    maxArgs: 255,
    ranges: TARGET_THEN_ODD,
  });
  registerFunction(registry, "MAXIFS", multiCondition(() => extremeReducer(true)), {
    minArgs: 3,
    maxArgs: 255,
    ranges: TARGET_THEN_ODD,
  });
  registerFunction(registry, "MINIFS", multiCondition(() => extremeReducer(false)), {
    minArgs: 3,
    maxArgs: 255,
    ranges: TARGET_THEN_ODD,
  });
}
