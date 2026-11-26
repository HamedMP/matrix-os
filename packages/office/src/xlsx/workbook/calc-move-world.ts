/**
 * How `calc-positions.ts` reads the workbook to judge a row or column move:
 * as it is, within a budget of cells for the whole move, and as the move will
 * leave it, without making the move. It works out an OFFSET or INDIRECT call
 * both ways and compares the answers.
 *
 * After the move, cells keep their values and move with their lines;
 * inserted lines are empty. Formula text and defined names are rewritten as
 * the move rewrites them (`rewriteForStructure`), so a reference written in
 * them follows its cells, while an address INDIRECT reads from text does not.
 */

import type { CellProvider, FormulaAst, FormulaError, FormulaScalar, FunctionRegistry, RangeBounds } from "../../api/formula.js";
import { MAX_COLS, MAX_ROWS } from "./a1.js";
import { CLOCK_FUNCTIONS } from "./calc-graph.js";
import { type ReadLog, makeProvider } from "./calc-provider.js";
import { errorValue } from "./calc-values.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { lookupName } from "./names.js";
import { type StructuralOp, rewriteForStructure } from "./refs-rewrite.js";
import { sheetDimensions } from "./sheet-write.js";
import { parseCached } from "./state.js";

/** What working out computed arguments may still read during one move. */
export interface ArgumentBudget {
  cells: number;
}

/** Cells a read of `bounds` covers, clipped to the used part of the sheet as the provider clips it. */
function usedArea(state: WorkbookState, bounds: RangeBounds): number {
  const sheet = state.sheetsByKey.get(bounds.sheet.toLowerCase());
  const used = sheet === undefined ? null : sheetDimensions(sheet);
  if (used === null) return 0;
  const lastRow = Math.min(bounds.endRow, used.end.row);
  const lastCol = Math.min(bounds.endCol, used.end.col);
  if (bounds.startRow > lastRow || bounds.startCol > lastCol) return 0;
  return (lastRow - bounds.startRow + 1) * (lastCol - bounds.startCol + 1);
}

/** What one evaluation ran into that makes its answer say nothing about the run. */
export interface Meter {
  /** It needed more cells than the budget leaves. */
  over: boolean;
  /** It read a clock, which has no time here. */
  clock: boolean;
  /**
   * It read a cell that holds a formula. The run may give that cell another
   * value after the move, and a cell picked at run time is no input the run
   * sees changed.
   */
  formula: boolean;
}

/** True when a cell of `bounds`, clipped to the used part of the sheet, holds a formula. Costs at most {@link usedArea}. */
function holdsFormula(state: WorkbookState, bounds: RangeBounds): boolean {
  const sheet = state.sheetsByKey.get(bounds.sheet.toLowerCase());
  const used = sheet === undefined ? null : sheetDimensions(sheet);
  if (sheet === undefined || used === null) return false;
  const lastRow = Math.min(bounds.endRow, used.end.row);
  const lastCol = Math.min(bounds.endCol, used.end.col);
  for (let r = bounds.startRow; r <= lastRow; r++) {
    const row = sheet.rows.get(r);
    if (row === undefined) continue;
    if (row.cells.size < lastCol - bounds.startCol + 1) {
      for (const [col, cell] of row.cells) if (col >= bounds.startCol && col <= lastCol && cell.formula !== null) return true;
    } else {
      for (let c = bounds.startCol; c <= lastCol; c++) if ((row.cells.get(c)?.formula ?? null) !== null) return true;
    }
  }
  return false;
}

/** The workbook's provider, refusing reads past the budget and noting in `meter` that it did; `log` lists what it read. */
export function meteredProvider(state: WorkbookState, budget: ArgumentBudget, meter: Meter, log: ReadLog = { reads: null, overflow: false }): CellProvider {
  const inner = makeProvider(state, log);
  const spend = (count: number): boolean => {
    if (meter.over || count > budget.cells) {
      meter.over = true;
      return false;
    }
    budget.cells -= count;
    return true;
  };
  const read = (bounds: RangeBounds, cost: number): boolean => {
    if (!spend(cost)) return false;
    if (!meter.formula && holdsFormula(state, bounds)) meter.formula = true;
    return true;
  };
  return {
    getCellValue: (sheet, row, col) =>
      read({ sheet, startRow: row, startCol: col, endRow: row, endCol: col }, 1) ? inner.getCellValue(sheet, row, col) : errorValue("#NUM!"),
    getRangeValues: (bounds) => (read(bounds, usedArea(state, bounds)) ? inner.getRangeValues(bounds) : errorValue("#NUM!")),
    resolveName: (name, sheet) => inner.resolveName(name, sheet),
  };
}

/** The registry, noting in `meter` when a function that needs a time is looked up. */
export function clockNoting(functions: FunctionRegistry, meter: Meter): FunctionRegistry {
  return {
    register: (name, impl, options) => functions.register(name, impl, options),
    registerLazy: (name, impl, options) => functions.registerLazy(name, impl, options),
    get: (name) => {
      if (CLOCK_FUNCTIONS.has(name)) meter.clock = true;
      return functions.get(name);
    },
    has: (name) => functions.has(name),
    names: () => functions.names(),
  };
}

/** The tree of `text` after the move, for a formula or name whose unqualified references are on `owner`. */
export function treeAfterMove(state: WorkbookState, text: string, owner: SheetModel | null, sheet: SheetModel, op: StructuralOp): FormulaAst | null {
  return parseCached(state, rewriteForStructure(text, owner === sheet, sheet.name.toLowerCase(), op));
}

/** The line a line of the moved axis held before the move; -1 for an inserted one. */
function origin(position: number, op: StructuralOp): number {
  if (op.count > 0) {
    if (position < op.index) return position;
    return position < op.index + op.count ? -1 : position - op.count;
  }
  const before = position < op.index ? position : position - op.count;
  return before >= (op.axis === "row" ? MAX_ROWS : MAX_COLS) ? -1 : before;
}

/** The lines before the move that hold what lines `low` to `high` hold after it; null when all of them are inserted. */
function originSpan(low: number, high: number, op: StructuralOp): { low: number; high: number } | null {
  const limit = (op.axis === "row" ? MAX_ROWS : MAX_COLS) - 1;
  if (op.count > 0) {
    const end = op.index + op.count;
    const first = low < op.index ? low : low < end ? op.index : low - op.count;
    const last = high < op.index ? high : high < end ? op.index - 1 : high - op.count;
    return first > last ? null : { low: first, high: last };
  }
  const first = low < op.index ? low : low - op.count;
  const last = Math.min(high < op.index ? high : high - op.count, limit);
  return first > last ? null : { low: first, high: last };
}

/**
 * Picks the values of lines `low` to `high` after the move out of `values`,
 * which starts at line `from` before it. Inserted lines are blank; it stops
 * past the last line `values` holds, as the provider clips to the used cells.
 */
function pick<T>(values: readonly T[], from: number, low: number, high: number, op: StructuralOp, blank: T): T[] {
  const picked: T[] = [];
  for (let position = low; position <= high; position++) {
    const before = origin(position, op);
    if (before === -1) {
      picked.push(blank);
      continue;
    }
    if (before - from >= values.length) break;
    picked.push(values[before - from] as T);
  }
  return picked;
}

/**
 * Reads the workbook as it will be after `op` on `sheet`, through `before`,
 * the provider of the workbook as it is (so its limits apply to these reads).
 */
export function providerAfterMove(state: WorkbookState, sheet: SheetModel, op: StructuralOp, before: CellProvider): CellProvider {
  const moved = (name: string): boolean => state.sheetsByKey.get(name.toLowerCase()) === sheet;
  const rows = op.axis === "row";
  return {
    getCellValue(sheetName, row, col): FormulaScalar {
      if (!moved(sheetName)) return before.getCellValue(sheetName, row, col);
      const line = origin(rows ? row : col, op);
      if (line === -1) return null;
      return rows ? before.getCellValue(sheetName, line, col) : before.getCellValue(sheetName, row, line);
    },
    getRangeValues(bounds: RangeBounds): FormulaScalar[][] | FormulaError {
      if (!moved(bounds.sheet)) return before.getRangeValues(bounds);
      const low = rows ? bounds.startRow : bounds.startCol;
      const high = rows ? bounds.endRow : bounds.endCol;
      const span = originSpan(low, high, op);
      if (span === null) return [];
      const source = rows ? { ...bounds, startRow: span.low, endRow: span.high } : { ...bounds, startCol: span.low, endCol: span.high };
      const values = before.getRangeValues(source);
      if (!Array.isArray(values)) return values;
      if (rows) return pick<FormulaScalar[]>(values, span.low, low, high, op, []);
      return values.map((line) => pick<FormulaScalar>(line, span.low, low, high, op, null));
    },
    resolveName(name, sheetName) {
      const record = lookupName(state, name, state.sheetsByKey.get(sheetName.toLowerCase()) ?? null);
      if (record === null) return null;
      const ast = treeAfterMove(state, record.refersTo, record.scope, sheet, op);
      return ast === null ? null : { kind: "formula", ast, sheet: record.scope?.name ?? sheetName };
    },
  };
}
