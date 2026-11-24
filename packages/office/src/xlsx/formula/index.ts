/**
 * The spreadsheet formula engine. Implements `FormulaModule` (`api/formula.ts`).
 *
 * ```ts
 * const functions = createFunctionRegistry();
 * const ast = parseFormula("=SUM(A1:A3)*Rate");
 * const value = evaluateCell(ast, { provider, functions, sheet: "Sheet1", row: 0, col: 3 });
 * ```
 *
 * Parts, each documented in its own file:
 * - `parser/`: {@link parseFormula}, {@link serializeFormula}, the tree
 *   walkers ({@link collectReferences}, {@link mapReferences}) and the
 *   reference rewriting helpers for the workbook: {@link rewriteReferences}
 *   (rows, columns, cells or sheets inserted, deleted, moved, renamed) and
 *   {@link shiftReferences} (copy and fill), with text-to-text versions
 *   {@link rewriteFormulaText} and {@link shiftFormulaText}.
 * - `eval/`: {@link evaluate}, {@link evaluateCell}, the operators and the
 *   reference helpers.
 * - `graph/`: {@link DependencyGraph}, which tracks precedents and
 *   dependents and plans the recalculation of what is out of date.
 * - `registry.ts`: the function registry and its argument metadata.
 * - `functions/`: the function libraries ({@link registerA},
 *   {@link registerB}) that {@link createFunctionRegistry} loads.
 * - `coerce.ts`: conversion between value types, comparison, broadcasting.
 *
 * The workbook (`../workbook/`) calculates with {@link evaluate} and the
 * registry of {@link createFunctionRegistry}. It keeps a dependency graph of
 * its own over its cell records (`../workbook/calc-graph.ts`) and rewrites
 * references on formula text (`../workbook/refs-*.ts`), so that a formula it
 * cannot parse still follows its rows and columns. {@link DependencyGraph}
 * and the tree rewriting helpers here serve callers that hold parsed
 * formulas outside a workbook.
 *
 * Beyond the contract, {@link parseFormulaExtended} accepts the reference
 * operators (range between any references, intersection, union) and
 * references across a span of sheets, and every helper here accepts the
 * tree it produces.
 */

import type { FormulaModule, FormulaScalar } from "../../api/formula.js";
import { registerCoreFunctions } from "./eval/core-functions.js";
import { evaluate, type EvaluateOptions } from "./eval/evaluator.js";
import { toCellResult } from "./eval/reference.js";
import { registerA } from "./functions/register-a.js";
import { registerB } from "./functions/register-b.js";
import type { ExtendedAst } from "./parser/ast.js";
import { parseFormula } from "./parser/parser.js";
import { serializeFormula } from "./parser/serialize.js";
import { collectReferences, mapReferences } from "./parser/walk.js";
import { createRegistry, registerAll, type CoreFunctionRegistry, type FunctionLibrary } from "./registry.js";

export * from "./coerce.js";
export * from "./registry.js";
export * from "./parser/index.js";
export * from "./eval/index.js";
export * from "./graph/index.js";

export { registerA } from "./functions/register-a.js";
export { registerB } from "./functions/register-b.js";

/**
 * The function libraries of a registry with builtins, in registration
 * order. A later library replaces a function of an earlier one.
 *
 * - `registerCoreFunctions`: SUM, IF, IFERROR, AND, OR, NOT.
 * - `registerA`: math, statistical, logical and information functions.
 * - `registerB`: text, date and time, lookup and reference, and financial
 *   functions.
 *
 * A further library under `functions/` is added here: import its
 * `(registry: FunctionRegistry) => void` and append it to the list.
 */
export const FUNCTION_LIBRARIES: readonly FunctionLibrary[] = [registerCoreFunctions, registerA, registerB];

/**
 * Creates a function registry. With `builtins` (default true) it holds
 * every function of {@link FUNCTION_LIBRARIES}; with `builtins: false` it
 * is empty and the caller registers what it needs.
 */
export function createFunctionRegistry(options: { builtins?: boolean } = {}): CoreFunctionRegistry {
  const registry = createRegistry();
  return options.builtins === false ? registry : registerAll(registry, FUNCTION_LIBRARIES);
}

/**
 * Evaluates a formula to the one value its cell shows: {@link evaluate}
 * followed by {@link toCellResult} for the cell in the context. A reference
 * to a single cell gives that cell's value, a range is intersected with the
 * formula's row or column, an array gives its first value and blank is 0.
 */
export function evaluateCell(ast: ExtendedAst, context: EvaluateOptions): Exclude<FormulaScalar, null> {
  return toCellResult(evaluate(ast, context), context.row, context.col);
}

type Satisfies<Contract, Implementation extends Contract> = Implementation;

/** Compile-time proof that the exports of this file implement the contract. */
export type FormulaModuleImplementation = Satisfies<
  FormulaModule,
  {
    parseFormula: typeof parseFormula;
    serializeFormula: typeof serializeFormula;
    evaluate: typeof evaluate;
    collectReferences: typeof collectReferences;
    mapReferences: typeof mapReferences;
    createFunctionRegistry: typeof createFunctionRegistry;
  }
>;
