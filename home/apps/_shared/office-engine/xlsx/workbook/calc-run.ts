/**
 * One calculation of a workbook.
 *
 * A run has two parts. The first walks the order once: a formula is due when
 * it or something it names changed. The second exists for formulas that pick
 * their cells at run time (OFFSET, INDIRECT): the order cannot place them
 * after cells their text does not name, so each is calculated again when a
 * cell it actually read was stored after it, and the new value is carried on
 * to its dependants, until nothing moves.
 *
 * A bound that stops a run leaves the formulas it did not reach marked as
 * pending; the next run starts with those and does not redo the others.
 */

import type { CellProvider, FormulaScalar, FormulaValue, FunctionRegistry } from "../../api/formula.js";
import type { CellRange, CellValue, ChangedCell, SheetCellRef } from "../../api/xlsx.js";
import { isOfficeError } from "../../errors.js";
import { formatValue } from "../format/index.js";
import { type CalcGraph, type CalcNode, type Dep, functionsOf } from "./calc-graph.js";
import { type ReadLog, makeProvider } from "./calc-provider.js";
import { arrayCellValue, errorValue, toCellValue } from "./calc-values.js";
import { ensureRow, findCell } from "./cells.js";
import { DIRTY_CONTENT, DIRTY_STYLE, type SheetModel, type WorkbookState, cellKey } from "./model.js";
import { copyValue, sameValue } from "./state.js";

/** With more edited cells than this, everything is calculated instead of tracing what they reach. */
export const TRACE_LIMIT = 2000;
/** How often formulas that pick their cells at run time are calculated again before they count as circular. */
const MAX_ROUNDS = 32;

type CellSets = Map<SheetModel, Set<number>>;

/** The last time a cell was stored in a run, and the entry that reports it. */
interface StoreMark {
  seq: number;
  entry: ChangedCell;
}

/** True for an array formula that fills cells besides its own. */
function fillsRange(node: CalcNode): boolean {
  const spill = node.spill;
  return spill !== null && (spill.end.row > spill.start.row || spill.end.col > spill.start.col);
}

function touches(dep: Dep, changed: CellSets): boolean {
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

export function isEmpty(sets: CellSets): boolean {
  for (const set of sets.values()) if (set.size > 0) return false;
  return true;
}

export function addTo(sets: CellSets, sheet: SheetModel, key: number): void {
  let set = sets.get(sheet);
  if (set === undefined) {
    set = new Set();
    sets.set(sheet, set);
  }
  set.add(key);
}

/** One calculation of a workbook. */
export class Run {
  readonly changed: ChangedCell[] = [];
  readonly circular: SheetCellRef[] = [];
  private evaluated = 0;
  /** Values stored so far. */
  private seq = 0;
  /** Where stored cells are noted for the formulas still to come. */
  private sink: CellSets;
  /** Per stored cell, when it was last stored. Kept only when some formula picks its cells at run time. */
  private readonly marks: Map<SheetModel, Map<number, StoreMark>> | null;
  private readonly log: ReadLog = { reads: null, overflow: false };
  private readonly provider: CellProvider;
  private readonly functions: FunctionRegistry;
  private readonly format: (value: FormulaScalar, code: string) => string;

  constructor(
    private readonly state: WorkbookState,
    private readonly graph: CalcGraph,
    private readonly order: readonly CalcNode[],
    private readonly now: string | null,
    private readonly maxCells: number,
    /** Volatile formulas are calculated whether or not anything they read changed. */
    private readonly forced: boolean,
    private readonly all: boolean,
  ) {
    this.sink = state.calc.edited;
    this.marks = graph.dynamic.length > 0 ? new Map() : null;
    this.provider = makeProvider(state, this.log);
    this.functions = functionsOf(state) as FunctionRegistry;
    const date1904 = state.date1904;
    this.format = (value, code) => formatValue(value, code, { date1904 });
    for (const node of graph.dynamic) {
      node.evalAt = 0;
      node.doneAt = 0;
      node.turns = 0;
    }
  }

  /** Stores a calculated value and notes the cell as changed, for the formulas after it and for the caller. */
  private store(sheet: SheetModel, row: number, col: number, value: CellValue): void {
    const state = this.state;
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
    const key = cellKey(row, col);
    this.seq++;
    addTo(this.sink, sheet, key);
    const marks = this.marks;
    if (marks === null) {
      this.changed.push({ sheet: sheet.id, row, col, previous: copyValue(previous), value: copyValue(value) });
      return;
    }
    let ofSheet = marks.get(sheet);
    if (ofSheet === undefined) {
      ofSheet = new Map();
      marks.set(sheet, ofSheet);
    }
    const mark = ofSheet.get(key);
    if (mark !== undefined) {
      // Stored again in the same run: the caller hears of the cell once, with its last value.
      mark.seq = this.seq;
      mark.entry.value = copyValue(value);
      return;
    }
    const entry: ChangedCell = { sheet: sheet.id, row, col, previous: copyValue(previous), value: copyValue(value) };
    this.changed.push(entry);
    ofSheet.set(key, { seq: this.seq, entry });
  }

  /** Stores the value of a node and, for an array formula, the values of its range. */
  private put(node: CalcNode, value: CellValue, result: FormulaValue, same: boolean): void {
    node.evalAt = this.seq;
    this.store(node.sheet, node.row, node.col, value);
    if (fillsRange(node)) {
      const spill = node.spill as CellRange;
      for (let r = spill.start.row; r <= spill.end.row; r++) {
        for (let c = spill.start.col; c <= spill.end.col; c++) {
          if (r === node.row && c === node.col) continue;
          // A cell of the range with a formula of its own is not what the file promised; it is left alone.
          if (findCell(node.sheet, r, c)?.formula != null) continue;
          this.store(node.sheet, r, c, same ? value : arrayCellValue(result, r - spill.start.row, c - spill.start.col));
        }
      }
    }
    node.doneAt = this.seq;
  }

  private putCircular(node: CalcNode): void {
    this.circular.push({ sheet: node.sheet.id, row: node.row, col: node.col });
    const value = errorValue("#REF!");
    this.put(node, value, value, true);
  }

  /** Calculates one node. False when the bound on evaluated cells is reached; the node is then untouched. */
  private evaluate(node: CalcNode): boolean {
    if (node.circular) {
      this.putCircular(node);
      return true;
    }
    if (this.evaluated >= this.maxCells) return false;
    const spill = node.spill;
    // The cells an array formula fills count towards the bound like formulas of their own.
    this.evaluated += spill === null ? 1 : (spill.end.row - spill.start.row + 1) * (spill.end.col - spill.start.col + 1);
    const formula = this.state.formula;
    const log = this.log;
    if (node.dynamic) {
      log.reads = [];
      log.overflow = false;
    }
    let value: CellValue;
    let result: FormulaValue = null;
    try {
      result = (formula as NonNullable<typeof formula>).evaluate(node.ast, {
        provider: this.provider,
        functions: this.functions,
        sheet: node.sheet.name,
        row: node.row,
        col: node.col,
        now: this.now,
        date1904: this.state.date1904,
        formatValue: this.format,
      });
      value = spill === null ? toCellValue(result, node) : arrayCellValue(result, 0, 0);
    } catch (error) {
      // The engine reports calculation problems as values; a typed failure (a bound, say) becomes one too.
      if (!isOfficeError(error)) {
        log.reads = null;
        throw error;
      }
      value = errorValue("#VALUE!");
      result = value;
    }
    if (node.dynamic) {
      node.reads = log.reads;
      node.readsAll = log.overflow;
      log.reads = null;
    }
    this.put(node, value, result, false);
    return true;
  }

  /** True when the node, a cell its formula names or a cell of the range it fills is in `sets`. */
  private namedIn(node: CalcNode, sets: CellSets, own: boolean): boolean {
    if (own && sets.get(node.sheet)?.has(cellKey(node.row, node.col)) === true) return true;
    for (const dep of node.deps) if (touches(dep, sets)) return true;
    if (own && fillsRange(node)) {
      // A value typed over part of an array formula's range is not kept: the formula fills its range again.
      const spill = node.spill as CellRange;
      if (touches({ sheet: node.sheet, r1: spill.start.row, c1: spill.start.col, r2: spill.end.row, c2: spill.end.col }, sets)) return true;
    }
    return false;
  }

  /** As {@link namedIn}, counting what a formula that picks its cells at run time read last time. */
  private touched(node: CalcNode, sets: CellSets): boolean {
    if (this.namedIn(node, sets, true)) return true;
    if (!node.dynamic || node.reads === null) return false;
    if (node.readsAll) return !isEmpty(sets);
    for (const dep of node.reads) if (touches(dep, sets)) return true;
    return false;
  }

  /** True when a cell the node read was stored after the node was calculated. */
  private isStale(node: CalcNode): boolean {
    const marks = this.marks;
    if (marks === null || node.reads === null || node.circular || node.blocked) return false;
    if (node.readsAll) return this.seq > node.doneAt;
    for (const dep of node.reads) {
      const ofSheet = marks.get(dep.sheet);
      if (ofSheet === undefined || ofSheet.size === 0) continue;
      const area = (dep.r2 - dep.r1 + 1) * (dep.c2 - dep.c1 + 1);
      if (area <= ofSheet.size) {
        for (let r = dep.r1; r <= dep.r2; r++) {
          for (let c = dep.c1; c <= dep.c2; c++) {
            const mark = ofSheet.get(cellKey(r, c));
            if (mark !== undefined && mark.seq > node.evalAt) return true;
          }
        }
        continue;
      }
      for (const [key, mark] of ofSheet) {
        if (mark.seq <= node.evalAt) continue;
        const col = key % 16384;
        const row = (key - col) / 16384;
        if (row >= dep.r1 && row <= dep.r2 && col >= dep.c1 && col <= dep.c2) return true;
      }
    }
    return false;
  }

  /**
   * Marks as pending every node from `from` on that the cells in the sink
   * may reach, taking each such node as changed. With `everything`, all of them.
   */
  private defer(from: number, everything: boolean): void {
    const pending = this.state.calc.pending;
    const sink = this.sink;
    for (let i = from; i < this.order.length; i++) {
      const node = this.order[i] as CalcNode;
      const key = cellKey(node.row, node.col);
      const due =
        everything ||
        node.circular ||
        node.dynamic ||
        (this.forced && node.volatile) ||
        pending.get(node.sheet)?.has(key) === true ||
        this.namedIn(node, sink, true);
      if (!due) continue;
      addTo(pending, node.sheet, key);
      if (everything) continue;
      addTo(sink, node.sheet, key);
      if (!fillsRange(node)) continue;
      const spill = node.spill as CellRange;
      for (let r = spill.start.row; r <= spill.end.row; r++) for (let c = spill.start.col; c <= spill.end.col; c++) addTo(sink, node.sheet, cellKey(r, c));
    }
  }

  /** The walk over the order. False when the bound stopped it. */
  private first(): boolean {
    const pending = this.state.calc.pending;
    const sink = this.sink;
    for (let i = 0; i < this.order.length; i++) {
      const node = this.order[i] as CalcNode;
      const waiting = pending.get(node.sheet);
      const key = cellKey(node.row, node.col);
      const waited = waiting !== undefined && waiting.has(key);
      let due = this.all || node.circular || waited || (this.forced && (node.volatile || node.dynamic)) || (node.dynamic && node.reads === null);
      let touched: boolean | null = null;
      if (!due) {
        touched = this.touched(node, sink);
        due = touched;
      }
      if (!due) continue;
      // Without a time, a formula that needs one keeps the value it has unless what it reads changed.
      if (node.clock && this.now === null && node.cell.value !== null && !node.circular) {
        if (touched === null) touched = this.touched(node, sink);
        if (!touched) {
          if (waited) waiting.delete(key);
          continue;
        }
      }
      if (!this.evaluate(node)) {
        this.defer(i, this.all);
        return false;
      }
      if (waited) waiting.delete(key);
    }
    return true;
  }

  /** Calculates again the formulas whose run-time reads were stored after them. False when the bound stopped it. */
  private settle(): boolean {
    const dynamic = this.graph.dynamic;
    /** Formulas found to read one another in a circle; they hold `#REF!` for the rest of the run. */
    const closed = new Set<CalcNode>();
    let reverse = true;
    for (let round = 0; round < 2 * MAX_ROUNDS; round++) {
      const stale = dynamic.filter((node) => !closed.has(node) && this.isStale(node));
      if (stale.length === 0) return true;
      this.sink = new Map();
      if (round === MAX_ROUNDS) {
        // Still moving after this many rounds: these formulas read one another in a circle.
        const moving = new Set(stale);
        for (const node of dynamic) {
          if (closed.has(node) || !(moving.has(node) || node.turns * 4 >= MAX_ROUNDS)) continue;
          closed.add(node);
          this.putCircular(node);
        }
      } else {
        if (reverse) stale.reverse();
        reverse = !reverse;
        for (const node of stale) {
          node.turns++;
          if (this.evaluate(node)) continue;
          this.defer(0, false);
          return false;
        }
      }
      if (!this.spread()) return false;
    }
    return true;
  }

  /** Carries the cells in the sink on to the formulas that name them. False when the bound stopped it. */
  private spread(): boolean {
    if (isEmpty(this.sink)) return true;
    for (let i = 0; i < this.order.length; i++) {
      const node = this.order[i] as CalcNode;
      if (node.circular || !this.namedIn(node, this.sink, false)) continue;
      if (this.evaluate(node)) continue;
      this.defer(0, false);
      return false;
    }
    return true;
  }

  run(): boolean {
    const complete = this.first() && (this.marks === null || this.settle());
    if (this.marks !== null) {
      // A cell that came back to the value it had is not a change.
      let kept = 0;
      for (const entry of this.changed) if (!sameValue(entry.previous, entry.value)) this.changed[kept++] = entry;
      this.changed.length = kept;
    }
    return complete;
  }
}
