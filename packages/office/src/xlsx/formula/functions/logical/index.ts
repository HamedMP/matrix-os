/**
 * Logical functions: IFS, IFNA, XOR, SWITCH, TRUE, FALSE. IF, IFERROR, AND,
 * OR and NOT come from the engine's core functions (`eval/core-functions.ts`),
 * which `registerA` registers first.
 *
 * - IFS(test1, value1, ...): the value of the first true test; `#N/A` when
 *   none is true. Tests convert like IF (text other than TRUE/FALSE is
 *   `#VALUE!`). Applied element by element to arrays.
 * - IFNA(value, fallback): the fallback only for `#N/A`; other errors stay.
 * - XOR(...): TRUE when an odd number of arguments are true. Text and
 *   blanks inside ranges are skipped; `#VALUE!` when nothing is logical.
 * - SWITCH(expression, value1, result1, ..., [default]): the result of the
 *   first value equal to the expression (text compares without regard to
 *   case, a number never equals text); otherwise the default, or `#N/A`.
 *   An array expression or value is matched element by element.
 * - IFERROR and IFNA take each replacement from the matching position of an
 *   array fallback.
 */

import type { FormulaAst, FormulaScalar, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, broadcast, cellCount, isArray, isError, toBoolean, toScalar, valuesEqual } from "../../coerce.js";
import { replaceErrors } from "../../eval/core-functions.js";
import { registerFunction, registerLazyFunction } from "../../registry.js";

function ifs(args: readonly FormulaValue[]): FormulaValue {
  if (args.length % 2 !== 0) return ERR.VALUE;
  for (let i = 0; i < args.length; i += 2) {
    const test = toBoolean(args[i] ?? null);
    if (isError(test)) return test;
    if (test) return args[i + 1] ?? null;
  }
  return ERR.NA;
}

function ifNa(args: readonly FormulaAst[], context: FunctionContext): FormulaValue {
  return replaceErrors(args, context, (cell) => isError(cell) && cell.code === "#N/A");
}

function xor(args: readonly FormulaValue[]): FormulaValue {
  let seen = false;
  let trues = 0;
  for (const arg of args) {
    if (isArray(arg)) {
      for (const row of arg.values) {
        for (const cell of row) {
          if (isError(cell)) return cell;
          if (typeof cell !== "number" && typeof cell !== "boolean") continue;
          seen = true;
          if (cell !== 0 && cell !== false) trues += 1;
        }
      }
      continue;
    }
    const test = toBoolean(arg);
    if (isError(test)) return test;
    seen = true;
    if (test) trues += 1;
  }
  return seen ? trues % 2 === 1 : ERR.VALUE;
}

/** SWITCH on scalars: the subject first, then the value and result pairs and an optional default. */
function switchScalars(s: readonly FormulaScalar[]): FormulaScalar {
  const subject = s[0] as FormulaScalar;
  if (isError(subject)) return subject;
  const pairs = Math.floor((s.length - 1) / 2);
  for (let i = 0; i < pairs; i += 1) {
    const candidate = s[1 + i * 2] as FormulaScalar;
    if (isError(candidate)) return candidate;
    if (valuesEqual(subject, candidate)) return s[2 + i * 2] as FormulaScalar;
  }
  return (s.length - 1) % 2 === 1 ? (s[s.length - 1] as FormulaScalar) : ERR.NA;
}

/** SWITCH element by element, once the expression or a value to match is an array: every argument is evaluated. */
function switchArrays(subject: FormulaValue, args: readonly FormulaAst[], context: FunctionContext): FormulaValue {
  const values = [subject, ...args.slice(1).map((node) => context.evaluate(node))];
  return broadcast(values, switchScalars);
}

function switchFunction(args: readonly FormulaAst[], context: FunctionContext): FormulaValue {
  const evaluated = context.evaluate(args[0] as FormulaAst);
  if (isArray(evaluated) && cellCount(evaluated) > 1) return switchArrays(evaluated, args, context);
  const subject = toScalar(evaluated);
  if (isError(subject)) return subject;
  const pairs = Math.floor((args.length - 1) / 2);
  for (let i = 0; i < pairs; i += 1) {
    const value = context.evaluate(args[1 + i * 2] as FormulaAst);
    if (isArray(value) && cellCount(value) > 1) return switchArrays(evaluated, args, context);
    const candidate = toScalar(value);
    if (isError(candidate)) return candidate;
    if (valuesEqual(subject, candidate)) return context.evaluate(args[2 + i * 2] as FormulaAst);
  }
  return (args.length - 1) % 2 === 1 ? context.evaluate(args[args.length - 1] as FormulaAst) : ERR.NA;
}

export function registerLogicalFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "IFS", ifs, { minArgs: 2, maxArgs: 254, ranges: "none" });
  registerLazyFunction(registry, "IFNA", ifNa, { minArgs: 2, maxArgs: 2 });
  registerFunction(registry, "XOR", xor, { minArgs: 1, maxArgs: 254 });
  registerLazyFunction(registry, "SWITCH", switchFunction, { minArgs: 3, maxArgs: 254 });
  registerFunction(registry, "TRUE", () => true, { minArgs: 0, maxArgs: 0 });
  registerFunction(registry, "FALSE", () => false, { minArgs: 0, maxArgs: 0 });
}
