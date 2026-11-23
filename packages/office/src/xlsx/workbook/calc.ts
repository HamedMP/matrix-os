/**
 * Calculation: evaluates out-of-date formula cells in dependency order.
 *
 * The formula engine evaluates one formula at a time and reads cells through
 * a {@link CellProvider}; this module decides which formulas to evaluate and
 * in which order, and stores the results as the cells' cached values.
 */

import type {
  CellProvider,
  FormulaError,
  FormulaScalar,
  FormulaValue,
  FunctionRegistry,
  NameResolution,
  RangeBounds,
} from "../../api/formula.js";
import type {
  CellAddress,
  CellRange,
  CellValue,
  ChangedCell,
  RecalcOptions,
  RecalcResult,
  SheetCellRef,
  SheetRangeRef,
} from "../../api/xlsx.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { formatValue } from "../format/index.js";
import { type CalcGraph, type CalcNode, type Dep, buildGraph, collectDeps, functionsOf, orderGraph } from "./calc-graph.js";
import { ensureRow, findCell } from "./cells.js";
import { DIRTY_CONTENT, DIRTY_STYLE, type SheetModel, type WorkbookState, cellKey } from "./model.js";
import { lookupName } from "./names.js";
import { sheetDimensions } from "./sheet-write.js";
import { copyValue, parseCached, sameValue } from "./state.js";

const DEFAULT_MAX_CELLS = 200_000;
const DEFAULT_MAX_DEPTH = 10_000;
/** Largest rectangle handed to a function in one piece. */
const MAX_RANGE_VALUES = 5_000_000;
/** With more edited cells than this, everything is calculated instead of tracing what they reach. */
const TRACE_LIMIT = 2000;

function errorValue(code: FormulaError["code"]): FormulaError {
  return { kind: "error", code };
}

/** True when the workbook has edits that formulas have not seen yet. */
export function needsRecalc(state: WorkbookState): boolean {
  if (state.calc.all) return true;
  for (const edited of state.calc.edited.values()) if (edited.size > 0) return true;
  return false;
}

function makeProvider(state: WorkbookState): CellProvider {
  const sheetByName = (name: string): SheetModel | undefined => state.sheetsByKey.get(name.toLowerCase());
  return {
    getCellValue(sheetName, row, col): FormulaScalar {
      const sheet = sheetByName(sheetName);
      if (sheet === undefined) return errorValue("#REF!");
      return sheet.rows.get(row)?.cells.get(col)?.value ?? null;
    },
    getRangeValues(bounds: RangeBounds): FormulaScalar[][] | FormulaError {
      const sheet = sheetByName(bounds.sheet);
      if (sheet === undefined) return errorValue("#REF!");
      const used = sheetDimensions(sheet);
      if (used === null) return [];
      const lastRow = Math.min(bounds.endRow, used.end.row);
      const lastCol = Math.min(bounds.endCol, used.end.col);
      if (bounds.startRow > lastRow || bounds.startCol > lastCol) return [];
      const width = lastCol - bounds.startCol + 1;
      if ((lastRow - bounds.startRow + 1) * width > MAX_RANGE_VALUES) return errorValue("#VALUE!");
      const values: FormulaScalar[][] = [];
      for (let r = bounds.startRow; r <= lastRow; r++) {
        const line = new Array<FormulaScalar>(width).fill(null);
        const row = sheet.rows.get(r);
        if (row !== undefined) {
          if (row.cells.size < width) {
            for (const [col, cell] of row.cells) if (col >= bounds.startCol && col <= lastCol) line[col - bounds.startCol] = cell.value;
          } else {
            for (let c = 0; c < width; c++) line[c] = row.cells.get(bounds.startCol + c)?.value ?? null;
          }
        }
        values.push(line);
      }
      return values;
    },
    resolveName(name, sheetName): NameResolution | null {
      const record = lookupName(state, name, sheetByName(sheetName) ?? null);
      if (record === null) return null;
      const ast = parseCached(state, record.refersTo);
      return ast === null ? null : { kind: "formula", ast, sheet: record.scope?.name ?? sheetName };
    },
  };
}

/** A calculated scalar as a cell stores it: blank is 0 and a number that is not finite is an error. */
function scalarValue(value: FormulaScalar): CellValue {
  if (value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : errorValue("#NUM!");
  if (typeof value === "object") return errorValue(value.code);
  return value;
}

/**
 * The value an array formula shows `rowOffset` rows and `colOffset` columns
 * from its first cell. One row or one column of results is repeated over
 * the range; a cell beyond the results shows `#N/A`.
 */
function arrayCellValue(result: FormulaValue, rowOffset: number, colOffset: number): CellValue {
  if (result === null || typeof result !== "object" || result.kind !== "array") return scalarValue(result);
  const ref = result.ref;
  const rows = ref === null ? result.rows : ref.endRow - ref.startRow + 1;
  const cols = ref === null ? result.cols : ref.endCol - ref.startCol + 1;
  const r = rows === 1 ? 0 : rowOffset;
  const c = cols === 1 ? 0 : colOffset;
  if (r >= rows || c >= cols) return errorValue("#N/A");
  return scalarValue(result.values[r]?.[c] ?? null);
}

/** Reduces a formula result to the one value its cell shows. */
function toCellValue(result: FormulaValue, node: CalcNode): CellValue {
  let value: FormulaScalar;
  if (result !== null && typeof result === "object" && result.kind === "array") {
    // A range result shows the value on the formula's own row or column; any other array shows its first value.
    let r = 0;
    let c = 0;
    const ref = result.ref;
    if (ref !== null) {
      if (ref.startCol === ref.endCol && node.row >= ref.startRow && node.row <= ref.endRow) r = node.row - ref.startRow;
      else if (ref.startRow === ref.endRow && node.col >= ref.startCol && node.col <= ref.endCol) c = node.col - ref.startCol;
      else if (ref.startRow !== ref.endRow || ref.startCol !== ref.endCol) return errorValue("#VALUE!");
    }
    value = result.values[r]?.[c] ?? null;
  } else {
    value = result;
  }
  return scalarValue(value);
}

/** True for an array formula that fills cells besides its own. */
function fillsRange(node: CalcNode): boolean {
  const spill = node.spill;
  return spill !== null && (spill.end.row > spill.start.row || spill.end.col > spill.start.col);
}

function touches(dep: Dep, changed: Map<SheetModel, Set<number>>): boolean {
  const set = changed.get(dep.sheet);
  if (set === undefined || set.size === 0) return false;
  const area = (dep.r2 - dep.r1 + 1) * (dep.c2 - dep.c1 + 1);
  if (area <= set.size) {
    for (let r = dep.r1; r <= dep.r2; r++) for (let c = dep.c1; c <= dep.c2; c++) if (set.has(cellKey(r, c))) return true;
    return false;
  }
  for (const key of set) {
    const col = key % 16384;
    const row = (key - col) / 16384;
    if (row >= dep.r1 && row <= dep.r2 && col >= dep.c1 && col <= dep.c2) return true;
  }
  return false;
}

function graphOf(state: WorkbookState): CalcGraph {
  let graph = state.calc.graph as CalcGraph | null;
  if (graph === null) {
    graph = buildGraph(state);
    state.calc.graph = graph;
  }
  return graph;
}

function bound(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Calculates out-of-date formulas. `explicit` is false for the run `save`
 * makes on its own, which leaves volatile formulas alone unless an input of
 * theirs changed.
 */
export function recalc(state: WorkbookState, options: RecalcOptions | undefined, explicit: boolean): RecalcResult {
  const formula = state.formula;
  const calc = state.calc;
  if (options?.now !== undefined) calc.lastNow = options.now;
  if (formula === null) {
    calc.edited.clear();
    calc.all = false;
    return { changed: [], circular: [], complete: true };
  }
  const functions = functionsOf(state) as FunctionRegistry;
  const maxCells = bound(options?.maxCells, DEFAULT_MAX_CELLS);
  const maxDepth = Math.max(1, bound(options?.maxDepth, DEFAULT_MAX_DEPTH));
  const graph = graphOf(state);
  let complete = true;
  let order = graph.order;
  if (order === null) {
    const ordered = orderGraph(graph, maxDepth);
    order = ordered.order;
    complete = ordered.complete;
    if (complete) graph.order = order;
  }
  let editedCount = 0;
  for (const edited of calc.edited.values()) editedCount += edited.size;
  const all = calc.all || editedCount > TRACE_LIMIT;
  const changedSets = calc.edited;
  const provider = makeProvider(state);
  const now = options?.now ?? calc.lastNow;
  const date1904 = state.date1904;
  const format = (value: FormulaScalar, code: string): string => formatValue(value, code, { date1904 });
  const changed: ChangedCell[] = [];
  const circular: SheetCellRef[] = [];
  let evaluated = 0;
  /** Stores a calculated value and notes the cell as changed, for the formulas after it and for the caller. */
  const store = (sheet: SheetModel, row: number, col: number, value: CellValue): void => {
    let rowRec = sheet.rows.get(row);
    let cell = rowRec?.cells.get(col);
    const previous = cell?.value ?? null;
    if (sameValue(previous, value)) return;
    if (cell === undefined) {
      // Only an array formula writes to a cell that does not exist yet.
      if (state.cellCount >= state.maxCells) return;
      rowRec = ensureRow(sheet, row);
      cell = { value, formula: null, styleId: 0, el: null, dirty: DIRTY_CONTENT | DIRTY_STYLE, shared: -1, extra: null };
      rowRec.cells.set(col, cell);
      state.cellCount++;
      sheet.dimensions = undefined;
    } else {
      cell.value = value;
      cell.dirty |= DIRTY_CONTENT;
    }
    if (rowRec !== undefined) rowRec.dirty = true;
    sheet.dirty = true;
    changed.push({ sheet: sheet.id, row, col, previous: copyValue(previous), value: copyValue(value) });
    let set = changedSets.get(sheet);
    if (set === undefined) {
      set = new Set();
      changedSets.set(sheet, set);
    }
    set.add(cellKey(row, col));
  };
  for (const node of order) {
    const key = cellKey(node.row, node.col);
    let due = all || node.circular || (node.always && explicit) || changedSets.get(node.sheet)?.has(key) === true;
    if (!due) for (const dep of node.deps) if (touches(dep, changedSets)) {
      due = true;
      break;
    }
    const spill = fillsRange(node) ? (node.spill as CellRange) : null;
    // A value typed over part of an array formula's range is not kept: the formula fills its range again.
    if (!due && spill !== null) {
      due = touches({ sheet: node.sheet, r1: spill.start.row, c1: spill.start.col, r2: spill.end.row, c2: spill.end.col }, changedSets);
    }
    if (!due) continue;
    let value: CellValue;
    let result: FormulaValue = null;
    if (node.circular) {
      circular.push({ sheet: node.sheet.id, row: node.row, col: node.col });
      value = errorValue("#REF!");
    } else {
      if (evaluated >= maxCells) {
        complete = false;
        break;
      }
      // The cells an array formula fills count towards the bound like formulas of their own.
      evaluated += spill === null ? 1 : (spill.end.row - spill.start.row + 1) * (spill.end.col - spill.start.col + 1);
      try {
        result = formula.evaluate(node.ast, {
          provider,
          functions,
          sheet: node.sheet.name,
          row: node.row,
          col: node.col,
          now,
          date1904,
          formatValue: format,
        });
        value = node.spill === null ? toCellValue(result, node) : arrayCellValue(result, 0, 0);
      } catch (error) {
        // The engine reports calculation problems as values; a typed failure (a bound, say) becomes one too.
        if (!isOfficeError(error)) throw error;
        value = errorValue("#VALUE!");
        result = value;
      }
    }
    store(node.sheet, node.row, node.col, value);
    if (spill === null) continue;
    for (let r = spill.start.row; r <= spill.end.row; r++) {
      for (let c = spill.start.col; c <= spill.end.col; c++) {
        if (r === node.row && c === node.col) continue;
        // A cell of the range with a formula of its own is not what the file promised; it is left alone.
        if (findCell(node.sheet, r, c)?.formula != null) continue;
        store(node.sheet, r, c, node.circular ? value : arrayCellValue(result, r - spill.start.row, c - spill.start.col));
      }
    }
  }
  calc.edited.clear();
  calc.all = !complete;
  return { changed, circular, complete };
}

export function precedents(state: WorkbookState, sheet: SheetModel, address: CellAddress): SheetRangeRef[] {
  const cell = findCell(sheet, address.row, address.col);
  if (cell === undefined || cell.formula === null) return [];
  const ast = parseCached(state, cell.formula);
  if (ast === null) return [];
  const deps: Dep[] = [];
  collectDeps(state, ast, sheet, 0, deps);
  return deps.map((dep) => ({ sheet: dep.sheet.id, start: { row: dep.r1, col: dep.c1 }, end: { row: dep.r2, col: dep.c2 } }));
}

export function dependents(state: WorkbookState, sheet: SheetModel, address: CellAddress): SheetCellRef[] {
  if (state.formula === null) return [];
  const found: SheetCellRef[] = [];
  for (const node of graphOf(state).nodes) {
    for (const dep of node.deps) {
      if (dep.sheet === sheet && address.row >= dep.r1 && address.row <= dep.r2 && address.col >= dep.c1 && address.col <= dep.c2) {
        found.push({ sheet: node.sheet.id, row: node.row, col: node.col });
        break;
      }
    }
  }
  const position = new Map(state.sheets.map((entry, index) => [entry.id, index] as const));
  return found.sort(
    (a, b) => (position.get(a.sheet) ?? 0) - (position.get(b.sheet) ?? 0) || a.row - b.row || a.col - b.col,
  );
}

/** Checks formula text given by a caller. Throws `formula_error` when it does not parse. */
export function checkFormula(state: WorkbookState, text: string): void {
  if (text.trim() === "") throw new OfficeError("formula_error", "the formula is empty");
  if (state.formula === null) return;
  state.formula.parseFormula(text);
}
