/**
 * The cells a formula that needs a time reads at run time, worked out for one
 * that has no record of them: it has not been calculated since its workbook
 * was opened.
 *
 * A run without a time keeps such a formula's date only when what it reads
 * did not change, so "nothing recorded" must not mean "reads nothing". Each
 * call that picks its cells at run time (and each name past the depth the
 * graph follows) is worked out on its own with the engine, against the
 * workbook as it is now, and the cells it read are recorded as if the formula
 * had read them. A call worked out alone reads at least what it reads inside
 * the formula, so the record may hold more cells, never fewer. Its address
 * may depend on other cells only through cells it reads, which the record
 * then holds as well.
 *
 * When that cannot be worked out (a clock steers what it reads, a typed
 * failure, more than {@link RESOLVE_CELLS} cells, or more rectangles than a
 * record keeps), the formula may read any cell, and any change counts.
 */

import type { FormulaAst } from "../../api/formula.js";
import { isOfficeError } from "../../errors.js";
import { formatValue } from "../format/index.js";
import { type CalcNode, MAX_NAME_DEPTH, functionsOf, picksCells, pushChildren } from "./calc-graph.js";
import { type Meter, clockNoting, meteredProvider } from "./calc-move-world.js";
import type { ReadLog } from "./calc-provider.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { lookupName } from "./names.js";
import { parseCached } from "./state.js";

/** Cells that working out what one formula reads may read. */
export const RESOLVE_CELLS = 100_000;

/** Lists in `log` the cells the parts of `node` that pick them at run time read. False when that cannot be worked out. */
function readParts(state: WorkbookState, node: CalcNode, log: ReadLog): boolean {
  const formula = state.formula;
  const functions = functionsOf(state);
  if (formula === null || functions === null) return false;
  const meter: Meter = { over: false, clock: false, formula: false };
  const provider = meteredProvider(state, { cells: RESOLVE_CELLS }, meter, log);
  const registry = clockNoting(functions, meter);
  const date1904 = state.date1904;
  const read = (ast: FormulaAst, sheet: SheetModel): boolean => {
    try {
      formula.evaluate(ast, {
        provider,
        functions: registry,
        sheet: sheet.name,
        row: node.row,
        col: node.col,
        now: null,
        date1904,
        formatValue: (scalar, code) => formatValue(scalar, code, { date1904 }),
      });
    } catch (error) {
      // As in a run: a typed failure is an answer the formula has no value for; anything else is a defect.
      if (!isOfficeError(error)) throw error;
      return false;
    }
    return !meter.over && !meter.clock && !log.overflow;
  };
  // Names are followed to the depth the graph follows, as `addTraits` does, so the walk ends.
  const pending: Array<{ ast: FormulaAst; sheet: SheetModel; depth: number }> = [{ ast: node.ast, sheet: node.sheet, depth: 0 }];
  const stack: FormulaAst[] = [];
  while (pending.length > 0) {
    const part = pending.pop() as { ast: FormulaAst; sheet: SheetModel; depth: number };
    stack.push(part.ast);
    while (stack.length > 0) {
      const current = stack.pop() as FormulaAst;
      if (current.type === "name") {
        // Past the depth the graph follows, the name's cells are known only from working it out.
        if (part.depth >= MAX_NAME_DEPTH) {
          if (!read(current, part.sheet)) return false;
          continue;
        }
        const scope = current.sheet === null ? part.sheet : (state.sheetsByKey.get(current.sheet.toLowerCase()) ?? null);
        const name = lookupName(state, current.name, scope);
        const inner = name === null ? null : parseCached(state, name.refersTo);
        if (name !== null && inner !== null) pending.push({ ast: inner, sheet: name.scope ?? part.sheet, depth: part.depth + 1 });
        continue;
      }
      if (picksCells(state, current, part.sheet)) {
        // Worked out whole, the call reads what its arguments read too.
        if (!read(current, part.sheet)) return false;
        continue;
      }
      pushChildren(current, stack);
    }
  }
  return true;
}

/**
 * Gives a formula that needs a time and picks its cells at run time, and has
 * no record of what it read, the record of what it reads now (see the file
 * comment). The run then judges it, and calculates it again when one of those
 * cells is stored after it, as it does after a calculation.
 */
export function resolveReads(state: WorkbookState, node: CalcNode): void {
  if (!node.dynamic || !node.clock || node.reads !== null) return;
  const log: ReadLog = { reads: [], overflow: false };
  const known = readParts(state, node, log);
  node.reads = log.reads ?? [];
  node.readsAll = !known || log.overflow;
}
