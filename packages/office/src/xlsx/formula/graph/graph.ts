/**
 * The dependency graph of a workbook's formulas.
 *
 * The graph knows, for every formula cell, the cells, ranges and defined
 * names it reads (its precedents), and from that which formula cells read a
 * given cell (its dependents). It keeps track of what is out of date and
 * orders the recalculation; it does not hold values and does not evaluate.
 *
 * ```ts
 * const graph = new DependencyGraph({ functions, resolveName });
 * graph.setFormula("Sheet1", 0, 2, parseFormula("A1+B1"));   // C1
 * graph.markDirty("Sheet1", 0, 0);                             // A1 was edited
 * graph.recalculate({
 *   compute: (cell) => store(cell, evaluateCell(astOf(cell), contextFor(cell))),
 *   circular: (cell) => store(cell, CIRCULAR_REFERENCE),
 * });
 * ```
 *
 * Rules:
 * - Sheet names compare without regard to case.
 * - `setFormula` marks the cell out of date. `markDirty` on a value cell
 *   marks every formula that reads it, directly or through other formulas.
 * - A formula that calls a volatile function (NOW, RAND) is recalculated on
 *   every run. A function whose reference is only known at evaluation time
 *   (OFFSET, INDIRECT) must be registered as volatile for the same reason.
 * - Cells that read each other in a circle are handed to `circular`, not
 *   `compute`; the cells that read them are computed afterwards.
 * - After rows, columns or sheets were inserted, removed, moved or renamed,
 *   rebuild the graph: `clear()` and `setFormula` for every formula cell.
 */

import type { RangeBounds } from "../../../api/formula.js";
import { OfficeError } from "../../../errors.js";
import { boundsOfNode } from "../eval/reference.js";
import { sameSheet } from "../parser/a1.js";
import type { ExtendedAst } from "../parser/ast.js";
import { visitNodes } from "../parser/walk.js";
import { calculationOrder } from "./order.js";
import { RangeIndex, rectContains, type RangeEntry } from "./range-index.js";
import {
  MAX_GRAPH_DIRTY_CELLS,
  MAX_GRAPH_FORMULAS,
  MAX_GRAPH_SHEETS,
  type CellRef,
  type GraphOptions,
  type GraphRecalcOptions,
  type GraphRecalcResult,
  type Precedent,
  type RecalcHandlers,
  type RecalcStep,
} from "./types.js";

/** How deep defined names are followed into each other when collecting precedents. */
const MAX_NAME_DEPTH = 32;
/** The most precedents kept for one formula; a formula with more is recalculated on every run. */
const MAX_PRECEDENTS = 4096;
const COLUMNS = 16_384;


interface FormulaNode extends CellRef {
  readonly sheetKey: string;
  readonly key: number;
  ast: ExtendedAst;
  precedents: Precedent[];
  cells: Array<{ sheetKey: string; key: number }>;
  ranges: Array<{ sheetKey: string; entry: RangeEntry<FormulaNode> }>;
  names: string[];
  volatile: boolean;
}

interface SheetIndex {
  readonly formulas: Map<number, FormulaNode>;
  readonly readers: Map<number, Set<FormulaNode>>;
  readonly ranges: RangeIndex<FormulaNode>;
  /** Value cells marked out of date since the last run. */
  readonly dirty: Set<number>;
}

interface Plan {
  order: FormulaNode[];
  circular: Set<FormulaNode>;
  /** Nodes that must be computed whatever their precedents do. */
  seeds: Set<FormulaNode>;
  successors: Map<FormulaNode, FormulaNode[]>;
  /** Nodes left for a later run because of a limit. */
  deferred: FormulaNode[];
}

const cellKey = (row: number, col: number): number => row * COLUMNS + col;
const sheetKeyOf = (sheet: string): string => sheet.toUpperCase();
const toRef = (node: CellRef): CellRef => ({ sheet: node.sheet, row: node.row, col: node.col });

export class DependencyGraph {
  // Bounded by MAX_GRAPH_SHEETS. A sheet has an index only while it has formulas or cells a formula reads.
  private readonly sheets = new Map<string, SheetIndex>();
  // Bounded by MAX_GRAPH_FORMULAS: these grow with the formulas.
  private readonly nameReaders = new Map<string, Set<FormulaNode>>();
  private readonly volatile = new Set<FormulaNode>();
  private readonly dirtyNodes = new Set<FormulaNode>();
  private count = 0;
  /** Value cells marked out of date, over every sheet; at most MAX_GRAPH_DIRTY_CELLS. */
  private dirtyCells = 0;
  /** Set when the out-of-date cells passed their cap: the next run takes every formula as out of date. */
  private allDirty = false;

  constructor(private readonly options: GraphOptions = {}) {}

  /** Number of formula cells. */
  get formulaCount(): number {
    return this.count;
  }

  /** True when a recalculation has something to do, volatile formulas aside. */
  get hasDirty(): boolean {
    return this.dirtyNodes.size > 0 || this.dirtyCells > 0 || (this.allDirty && this.count > 0);
  }

  /**
   * Registers or replaces the formula of a cell, or removes it with null.
   * The cell is marked out of date unless `dirty` is false (for a formula
   * loaded from a file together with its value).
   */
  setFormula(sheet: string, row: number, col: number, ast: ExtendedAst | null, options: { dirty?: boolean } = {}): void {
    const key = cellKey(row, col);
    if (ast === null) {
      // Without an index the sheet has no formula to drop and no cell any formula reads.
      const index = this.sheets.get(sheetKeyOf(sheet));
      if (index === undefined) return;
      const existing = index.formulas.get(key);
      if (existing !== undefined) this.drop(existing, index);
      if (options.dirty !== false) this.markCell(index, key);
      this.prune(sheetKeyOf(sheet));
      return;
    }
    const index = this.sheet(sheet);
    if (index === null) {
      throw new OfficeError("limit_exceeded", "too many sheets with formulas", { details: { max: MAX_GRAPH_SHEETS } });
    }
    const existing = index.formulas.get(key);
    let node = existing;
    if (node === undefined) {
      if (this.count >= MAX_GRAPH_FORMULAS) {
        throw new OfficeError("limit_exceeded", "too many formula cells", { details: { max: MAX_GRAPH_FORMULAS } });
      }
      node = { sheet, row, col, sheetKey: sheetKeyOf(sheet), key, ast, precedents: [], cells: [], ranges: [], names: [], volatile: false };
      index.formulas.set(key, node);
      this.count += 1;
    } else {
      this.unlink(node);
      node.ast = ast;
    }
    this.link(node);
    if (options.dirty !== false) this.dirtyNodes.add(node);
  }

  /** Removes the formula of a cell. Returns false when it had none. */
  removeFormula(sheet: string, row: number, col: number): boolean {
    const index = this.sheets.get(sheetKeyOf(sheet));
    const node = index?.formulas.get(cellKey(row, col));
    if (index === undefined || node === undefined) return false;
    this.drop(node, index);
    this.markCell(index, node.key);
    this.prune(node.sheetKey);
    return true;
  }

  hasFormula(sheet: string, row: number, col: number): boolean {
    return this.sheets.get(sheetKeyOf(sheet))?.formulas.has(cellKey(row, col)) === true;
  }

  /** True when the formula of the cell is recalculated on every run. */
  isVolatile(sheet: string, row: number, col: number): boolean {
    const node = this.sheets.get(sheetKeyOf(sheet))?.formulas.get(cellKey(row, col));
    return node !== undefined && node.volatile;
  }

  /** Marks a cell out of date: its own formula, if it has one, and every formula that reads it. */
  markDirty(sheet: string, row: number, col: number): void {
    // Without an index no formula is on the sheet or reads a cell of it.
    const index = this.sheets.get(sheetKeyOf(sheet));
    if (index === undefined) return;
    const key = cellKey(row, col);
    const node = index.formulas.get(key);
    if (node !== undefined) this.dirtyNodes.add(node);
    else this.markCell(index, key);
  }

  /** Marks every cell of a rectangle out of date, for a paste, a clear or a fill. */
  markRangeDirty(bounds: RangeBounds): void {
    const index = this.sheets.get(sheetKeyOf(bounds.sheet));
    if (index === undefined) return;
    for (const node of index.formulas.values()) {
      if (rectContains(bounds, node.row, node.col)) this.dirtyNodes.add(node);
    }
    for (const [key, readers] of index.readers) {
      if (!rectContains(bounds, Math.floor(key / COLUMNS), key % COLUMNS)) continue;
      for (const reader of readers) this.dirtyNodes.add(reader);
    }
    index.ranges.intersecting(bounds, (entry) => {
      for (const reader of entry.owners) this.dirtyNodes.add(reader);
    });
  }

  /**
   * Call when a defined name was added, changed or removed: the formulas
   * that use it read their precedents again and are marked out of date.
   */
  markNameDirty(name: string): void {
    const readers = this.nameReaders.get(name.toUpperCase());
    if (readers === undefined) return;
    for (const node of [...readers]) {
      this.unlink(node);
      this.link(node);
      this.dirtyNodes.add(node);
    }
  }

  /** Marks every formula out of date. */
  markAllDirty(): void {
    for (const sheet of this.sheets.values()) {
      for (const node of sheet.formulas.values()) this.dirtyNodes.add(node);
    }
  }

  /**
   * What the formula of a cell reads directly: cells and ranges (those of
   * the defined names it uses included) and the names themselves. Empty for
   * a cell without a formula.
   */
  precedents(sheet: string, row: number, col: number): Precedent[] {
    const node = this.sheets.get(sheetKeyOf(sheet))?.formulas.get(cellKey(row, col));
    return node === undefined ? [] : node.precedents.map((p) => (p.kind === "range" ? { kind: "range", bounds: { ...p.bounds } } : { ...p }));
  }

  /** The formula cells that read a cell directly, by sheet, row and column. */
  dependents(sheet: string, row: number, col: number): CellRef[] {
    const index = this.sheets.get(sheetKeyOf(sheet));
    if (index === undefined) return [];
    return this.readersOf(index, row, col)
      .map(toRef)
      .sort((a, b) => (a.sheet === b.sheet ? a.row - b.row || a.col - b.col : a.sheet < b.sheet ? -1 : 1));
  }

  /**
   * The cells a recalculation would handle, in order, without changing
   * anything. Unlike `recalculate` it lists every out-of-date cell, also
   * those that might be skipped because their precedents do not change.
   */
  plan(options: GraphRecalcOptions = {}): { steps: RecalcStep[]; complete: boolean } {
    const plan = this.buildPlan(options);
    return {
      steps: plan.order.map((node) => ({ ...toRef(node), circular: plan.circular.has(node) })),
      complete: plan.deferred.length === 0,
    };
  }

  /**
   * Recalculates what is out of date, precedents first, and clears the
   * out-of-date marks of what it handled. When a handler throws, the marks
   * are kept and the exception is passed on.
   */
  recalculate(handlers: RecalcHandlers, options: GraphRecalcOptions = {}): GraphRecalcResult {
    const plan = this.buildPlan(options);
    const needed = new Set<FormulaNode>(plan.seeds);
    const circular: CellRef[] = [];
    let computed = 0;
    let skipped = 0;
    for (const node of plan.order) {
      let changed = true;
      if (plan.circular.has(node)) {
        handlers.circular(toRef(node));
        circular.push(toRef(node));
      } else if (needed.has(node)) {
        changed = handlers.compute(toRef(node)) !== false;
        computed += 1;
      } else {
        changed = false;
        skipped += 1;
      }
      if (!changed) continue;
      for (const next of plan.successors.get(node) ?? []) needed.add(next);
    }
    this.clearMarks();
    for (const node of plan.deferred) this.dirtyNodes.add(node);
    return { computed, skipped, circular, complete: plan.deferred.length === 0, remaining: plan.deferred.length };
  }

  /** Forgets every formula and every out-of-date mark. */
  clear(): void {
    this.sheets.clear();
    this.nameReaders.clear();
    this.volatile.clear();
    this.dirtyNodes.clear();
    this.dirtyCells = 0;
    this.allDirty = false;
    this.count = 0;
  }

  /** The index of a sheet, created when missing; null when that would pass MAX_GRAPH_SHEETS. */
  private sheet(name: string): SheetIndex | null {
    const key = sheetKeyOf(name);
    let index = this.sheets.get(key);
    if (index === undefined) {
      if (this.sheets.size >= MAX_GRAPH_SHEETS) return null;
      index = { formulas: new Map(), readers: new Map(), ranges: new RangeIndex<FormulaNode>(), dirty: new Set() };
      this.sheets.set(key, index);
    }
    return index;
  }

  /** Forgets the index of a sheet that no longer has formulas or cells a formula reads. */
  private prune(sheetKey: string): void {
    const index = this.sheets.get(sheetKey);
    if (index === undefined || index.formulas.size > 0 || index.readers.size > 0 || index.ranges.size > 0) return;
    this.dirtyCells -= index.dirty.size;
    this.sheets.delete(sheetKey);
  }

  /** Marks a value cell out of date; past MAX_GRAPH_DIRTY_CELLS every formula is taken as out of date instead. */
  private markCell(index: SheetIndex, key: number): void {
    if (this.allDirty || index.dirty.has(key)) return;
    if (this.dirtyCells >= MAX_GRAPH_DIRTY_CELLS) {
      for (const sheet of this.sheets.values()) sheet.dirty.clear();
      this.dirtyCells = 0;
      this.allDirty = true;
      return;
    }
    index.dirty.add(key);
    this.dirtyCells += 1;
  }

  /** Clears every out-of-date mark. */
  private clearMarks(): void {
    this.dirtyNodes.clear();
    for (const sheet of this.sheets.values()) sheet.dirty.clear();
    this.dirtyCells = 0;
    this.allDirty = false;
  }

  private readersOf(index: SheetIndex, row: number, col: number): FormulaNode[] {
    const found = new Set<FormulaNode>(index.readers.get(cellKey(row, col)));
    index.ranges.containing(row, col, (entry) => {
      for (const reader of entry.owners) found.add(reader);
    });
    return [...found];
  }

  private drop(node: FormulaNode, index: SheetIndex): void {
    this.unlink(node);
    index.formulas.delete(node.key);
    this.dirtyNodes.delete(node);
    this.count -= 1;
  }

  private unlink(node: FormulaNode): void {
    for (const cell of node.cells) {
      const index = this.sheets.get(cell.sheetKey);
      const readers = index?.readers.get(cell.key);
      if (index === undefined || readers === undefined) continue;
      readers.delete(node);
      if (readers.size === 0) index.readers.delete(cell.key);
      this.prune(cell.sheetKey);
    }
    for (const range of node.ranges) {
      this.sheets.get(range.sheetKey)?.ranges.remove(range.entry, node);
      this.prune(range.sheetKey);
    }
    for (const name of node.names) {
      const readers = this.nameReaders.get(name);
      if (readers === undefined) continue;
      readers.delete(node);
      if (readers.size === 0) this.nameReaders.delete(name);
    }
    this.volatile.delete(node);
    node.precedents = [];
    node.cells = [];
    node.ranges = [];
    node.names = [];
    node.volatile = false;
  }

  /** Reads the precedents of a node from its formula and files them. */
  private link(node: FormulaNode): void {
    const seen = new Set<string>();
    this.collect(node, node.ast, node.sheet, 0, seen);
    if (node.volatile) this.volatile.add(node);
  }

  private addBounds(node: FormulaNode, bounds: RangeBounds, seen: Set<string>): void {
    const sheetKey = sheetKeyOf(bounds.sheet);
    const single = bounds.startRow === bounds.endRow && bounds.startCol === bounds.endCol;
    const id = `${sheetKey}\u0000${bounds.startRow},${bounds.startCol},${bounds.endRow},${bounds.endCol}`;
    if (seen.has(id)) return;
    if (seen.size >= MAX_PRECEDENTS) {
      node.volatile = true;
      return;
    }
    seen.add(id);
    const index = this.sheet(bounds.sheet);
    if (index === null) {
      // Past the sheet cap the reads are not filed: the formula is recalculated on every run instead.
      node.volatile = true;
      return;
    }
    if (single) {
      const key = cellKey(bounds.startRow, bounds.startCol);
      let readers = index.readers.get(key);
      if (readers === undefined) {
        readers = new Set<FormulaNode>();
        index.readers.set(key, readers);
      }
      readers.add(node);
      node.cells.push({ sheetKey, key });
      node.precedents.push({ kind: "cell", sheet: bounds.sheet, row: bounds.startRow, col: bounds.startCol });
    } else {
      node.ranges.push({ sheetKey, entry: index.ranges.add(bounds, node) });
      node.precedents.push({ kind: "range", bounds });
    }
  }

  private addName(node: FormulaNode, name: string, sheet: string, depth: number, seen: Set<string>): void {
    const upper = name.toUpperCase();
    if (!node.names.includes(upper)) {
      node.names.push(upper);
      node.precedents.push({ kind: "name", name });
      let readers = this.nameReaders.get(upper);
      if (readers === undefined) {
        readers = new Set<FormulaNode>();
        this.nameReaders.set(upper, readers);
      }
      readers.add(node);
    }
    const resolution = this.options.resolveName?.(name, sheet) ?? null;
    if (resolution === null || resolution.kind !== "formula") return;
    const visit = `name\u0000${upper}\u0000${sheetKeyOf(resolution.sheet)}`;
    if (seen.has(visit)) return;
    if (depth >= MAX_NAME_DEPTH) {
      node.volatile = true;
      return;
    }
    seen.add(visit);
    this.collect(node, resolution.ast, resolution.sheet, depth + 1, seen);
  }

  private collect(node: FormulaNode, ast: ExtendedAst, sheet: string, depth: number, seen: Set<string>): void {
    const functions = this.options.functions;
    visitNodes(ast, (part) => {
      switch (part.type) {
        case "cell":
        case "range":
          this.addBounds(node, boundsOfNode(part, sheet), seen);
          break;
        case "name":
          this.addName(node, part.name, part.sheet ?? sheet, depth, seen);
          break;
        case "call":
          if (functions?.get(part.name)?.volatile === true) node.volatile = true;
          break;
        case "ref3d": {
          const names = this.options.sheetNames?.();
          const first = names?.findIndex((name) => sameSheet(name, part.startSheet)) ?? -1;
          const last = names?.findIndex((name) => sameSheet(name, part.endSheet)) ?? -1;
          if (names === undefined || first === -1 || last === -1) {
            node.volatile = true;
            break;
          }
          for (const name of names.slice(Math.min(first, last), Math.max(first, last) + 1)) {
            this.addBounds(node, boundsOfNode(part.ref, name), seen);
          }
          break;
        }
        default:
          break;
      }
    });
  }

  private buildPlan(options: GraphRecalcOptions): Plan {
    const seeds = new Set<FormulaNode>(this.dirtyNodes);
    if (this.allDirty) {
      for (const index of this.sheets.values()) for (const node of index.formulas.values()) seeds.add(node);
    }
    if (options.volatile !== false) for (const node of this.volatile) seeds.add(node);
    for (const index of this.sheets.values()) {
      for (const key of index.dirty) {
        for (const reader of this.readersOf(index, Math.floor(key / COLUMNS), key % COLUMNS)) seeds.add(reader);
      }
    }
    // Everything that reads a seed, directly or not, is out of date too.
    const affected = [...seeds];
    const member = new Set<FormulaNode>(seeds);
    const successors = new Map<FormulaNode, FormulaNode[]>();
    for (let i = 0; i < affected.length; i += 1) {
      const node = affected[i] as FormulaNode;
      const readers = this.readersOf(this.sheets.get(node.sheetKey) as SheetIndex, node.row, node.col);
      successors.set(node, readers);
      for (const reader of readers) {
        if (member.has(reader)) continue;
        member.add(reader);
        affected.push(reader);
      }
    }
    const sorted = calculationOrder(affected, (node) => successors.get(node) ?? []);
    const maxCells = options.maxCells ?? Number.MAX_SAFE_INTEGER;
    const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER;
    const order: FormulaNode[] = [];
    const deferred: FormulaNode[] = [];
    for (const node of sorted.order) {
      if (order.length < maxCells && (sorted.depth.get(node) ?? 1) <= maxDepth && deferred.length === 0) order.push(node);
      else deferred.push(node);
    }
    return { order, circular: sorted.circular, seeds, successors, deferred };
  }
}
