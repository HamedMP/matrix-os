/**
 * The functions the engine itself provides: SUM, IF, IFERROR, AND, OR, NOT.
 * Everything else comes from the function libraries.
 */

import type {
  FormulaAst,
  FormulaScalar,
  FormulaValue,
  FunctionContext,
  FunctionRegistry,
} from "../../../api/formula.js";
import {
  ERR,
  broadcast,
  cellCount,
  collectNumbers,
  isArray,
  isError,
  toBoolean,
  toScalar,
} from "../coerce.js";
import { registerFunction, registerLazyFunction } from "../registry.js";

function sum(args: readonly FormulaValue[]): FormulaValue {
  const numbers = collectNumbers(args);
  if (isError(numbers)) return numbers;
  let total = 0;
  for (const n of numbers) total += n;
  return Number.isFinite(total) ? total : ERR.NUM;
}

function ifFunction(args: readonly FormulaAst[], context: FunctionContext): FormulaValue {
  const condition = context.evaluate(args[0] as FormulaAst);
  const otherwise = (): FormulaValue => (args.length < 3 ? false : context.evaluate(args[2] as FormulaAst));
  if (isArray(condition) && cellCount(condition) > 1) {
    const whenTrue = context.evaluate(args[1] as FormulaAst);
    const whenFalse = otherwise();
    return broadcast([condition, whenTrue, whenFalse], (s) => {
      const test = toBoolean(s[0] as FormulaScalar);
      if (isError(test)) return test;
      return (test ? s[1] : s[2]) ?? null;
    });
  }
  const test = toBoolean(condition);
  if (isError(test)) return test;
  return test ? context.evaluate(args[1] as FormulaAst) : otherwise();
}

/**
 * IFERROR and IFNA: the value, with each cell that `replace` picks taken
 * from the same position of the fallback. The fallback is evaluated only
 * when something needs replacing; a scalar or single-cell fallback is used
 * at every position, a larger array is matched position by position.
 */
export function replaceErrors(
  args: readonly FormulaAst[],
  context: FunctionContext,
  replace: (cell: FormulaScalar) => boolean,
): FormulaValue {
  const value = context.evaluate(args[0] as FormulaAst);
  if (isArray(value) && cellCount(value) > 1) {
    if (!value.values.some((row) => row.some(replace))) return value;
    const fallback = context.evaluate(args[1] as FormulaAst);
    return broadcast([value, fallback], (s) => {
      const cell = s[0] as FormulaScalar;
      return replace(cell) ? (s[1] as FormulaScalar) : cell;
    });
  }
  return replace(toScalar(value)) ? context.evaluate(args[1] as FormulaAst) : value;
}

function ifError(args: readonly FormulaAst[], context: FunctionContext): FormulaValue {
  return replaceErrors(args, context, isError);
}

/**
 * AND and OR. Arguments are evaluated left to right and evaluation stops at
 * the first one that decides the result. Text and blanks inside a range are
 * ignored; text typed as an argument must read TRUE or FALSE.
 */
function logical(stopOn: boolean): (args: readonly FormulaAst[], context: FunctionContext) => FormulaValue {
  return (args, context) => {
    let seen = false;
    for (const arg of args) {
      const value = context.evaluate(arg);
      if (isArray(value)) {
        for (const row of value.values) {
          for (const cell of row) {
            if (isError(cell)) return cell;
            if (typeof cell !== "number" && typeof cell !== "boolean") continue;
            seen = true;
            if ((cell !== 0 && cell !== false) === stopOn) return stopOn;
          }
        }
        continue;
      }
      const test = toBoolean(value);
      if (isError(test)) return test;
      seen = true;
      if (test === stopOn) return stopOn;
    }
    return seen ? !stopOn : ERR.VALUE;
  };
}

function not(args: readonly FormulaValue[]): FormulaValue {
  const test = toBoolean(args[0] ?? null);
  return isError(test) ? test : !test;
}

/** Registers the core functions. A function library may replace any of them. */
export function registerCoreFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "SUM", sum, { minArgs: 1 });
  registerLazyFunction(registry, "IF", ifFunction, { minArgs: 2, maxArgs: 3 });
  registerLazyFunction(registry, "IFERROR", ifError, { minArgs: 2, maxArgs: 2 });
  registerLazyFunction(registry, "AND", logical(false), { minArgs: 1 });
  registerLazyFunction(registry, "OR", logical(true), { minArgs: 1 });
  registerFunction(registry, "NOT", not, { minArgs: 1, maxArgs: 1, ranges: "none" });
}
