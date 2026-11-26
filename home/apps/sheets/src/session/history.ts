/**
 * Undo and redo: what one step of an edit changed, and how to take it back.
 *
 * An entry is a list of steps in the order they were made. Undo applies them
 * backwards, redo forwards. Cell content is restored with the engine's raw
 * write, which records nothing; structure and layout use the workbook's own
 * methods, so formulas follow their rows and columns.
 */

import type { CellChange, CellRange, DefinedName, FrozenPanes, RawCell, SheetId, Workbook, WorkbookInternals } from "./engine";

/** What deleting rows or columns takes from a sheet besides cells: rules, links, notes, tables, hidden flags. */
export type SheetFeatures = NonNullable<ReturnType<WorkbookInternals["captureSheetFeatures"]>>;
import { acceptAgain, restoreAccepted } from "./implicit-accept";

/** One cell before and after an edit. */
export interface CellDelta {
  sheet: SheetId;
  row: number;
  col: number;
  before: RawCell;
  after: RawCell;
}

export interface BandCell {
  row: number;
  col: number;
  cell: RawCell;
}

/** What deleting rows or columns removes and breaks, kept to put it back. */
export interface DeletedBand {
  cells: BandCell[];
  /** Sizes of the deleted rows (points) or columns (characters), by index. */
  sizes: Array<{ index: number; size: number }>;
  merges: CellRange[];
  names: DefinedName[];
  /** Formulas the engine rewrote, at the position each cell has after the deletion. */
  rewrites: CellDelta[];
  /** Validation rules, links, conditional formats, notes, tables and hidden flags before the deletion; null when the sheet had none. */
  features: SheetFeatures | null;
}

/**
 * What an insertion rewrote besides moving cells, kept to put it back
 * exactly: deleting the rows again does not restore a reference the
 * insertion broke (`=A1048576` is `#REF!` once a row went in above it).
 */
export interface Rewritten {
  /** Formulas the engine rewrote, at the position each cell has after the edit. */
  rewrites: CellDelta[];
  /** Defined names the edit changed, as they were before it. */
  names: DefinedName[];
}

/** Characters of kept feature markup that weigh as much as one cell record. */
const FEATURE_CHARS_PER_CELL = 32;

/** How much a kept feature state weighs against the history's cell budget. */
export function featureWeight(features: SheetFeatures | null): number {
  if (features === null) return 0;
  let chars = 0;
  for (const text of features.elements) chars += text.length;
  for (const note of features.notes) chars += note.text.length;
  return Math.ceil(chars / FEATURE_CHARS_PER_CELL) + features.arrays.length + features.rows.length + (features.columns?.length ?? 0) + features.tables.length;
}

export type HistoryStep =
  | { kind: "cells"; deltas: CellDelta[] }
  | {
      kind: "axis";
      sheet: SheetId;
      axis: "row" | "col";
      index: number;
      count: number;
      insert: true;
      rewritten: Rewritten;
      /** Rules, links, notes, tables and hidden flags before the insertion; null when the sheet had none. */
      features: SheetFeatures | null;
    }
  | { kind: "axis"; sheet: SheetId; axis: "row" | "col"; index: number; count: number; insert: false; band: DeletedBand }
  | { kind: "size"; sheet: SheetId; axis: "row" | "col"; changes: Array<{ index: number; before: number | null; after: number | null }> }
  | { kind: "merges"; sheet: SheetId; before: CellRange[]; after: CellRange[] }
  | { kind: "frozen"; sheet: SheetId; before: FrozenPanes; after: FrozenPanes }
  | { kind: "rename"; sheet: SheetId; before: string; after: string }
  /** Proposed changes the edit accepted by writing over their cells; first in its entry. See `./implicit-accept.ts`. */
  | { kind: "accepted"; changes: CellChange[] };

export interface HistoryEntry {
  label: string;
  steps: HistoryStep[];
}

/** Most entries kept on each stack. */
export const MAX_HISTORY_ENTRIES = 200;
/** Most cell records kept over all entries of a stack; the oldest entries go first. */
export const MAX_HISTORY_CELLS = 1_000_000;

function rewrittenWeight(rewritten: Rewritten): number {
  return rewritten.rewrites.length + rewritten.names.length;
}

function stepWeight(step: HistoryStep): number {
  if (step.kind === "cells") return step.deltas.length;
  if (step.kind === "axis" && !step.insert) return step.band.cells.length + step.band.rewrites.length + featureWeight(step.band.features) + 1;
  if (step.kind === "axis") return rewrittenWeight(step.rewritten) + featureWeight(step.features) + 1;
  if (step.kind === "accepted") return step.changes.length;
  return 1;
}

export function entryWeight(entry: HistoryEntry): number {
  let weight = 0;
  for (const step of entry.steps) weight += stepWeight(step);
  return weight;
}

/** Two bounded stacks. A new entry empties the redo stack. */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private undoWeight = 0;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get size(): number {
    return this.undoStack.length;
  }

  push(entry: HistoryEntry): void {
    this.redoStack = [];
    this.pushUndo(entry);
  }

  private pushUndo(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    this.undoWeight += entryWeight(entry);
    while (this.undoStack.length > 1 && (this.undoStack.length > MAX_HISTORY_ENTRIES || this.undoWeight > MAX_HISTORY_CELLS)) {
      const dropped = this.undoStack.shift() as HistoryEntry;
      this.undoWeight -= entryWeight(dropped);
    }
  }

  /** The entry to take back, or null. Call {@link settleUndo} once it was applied. */
  peekUndo(): HistoryEntry | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  peekRedo(): HistoryEntry | null {
    return this.redoStack[this.redoStack.length - 1] ?? null;
  }

  settleUndo(): void {
    const entry = this.undoStack.pop();
    if (entry === undefined) return;
    this.undoWeight -= entryWeight(entry);
    this.redoStack.push(entry);
    if (this.redoStack.length > MAX_HISTORY_ENTRIES) this.redoStack.shift();
  }

  settleRedo(): void {
    const entry = this.redoStack.pop();
    if (entry !== undefined) this.pushUndo(entry);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.undoWeight = 0;
  }
}

function sameRange(a: CellRange, b: CellRange): boolean {
  return a.start.row === b.start.row && a.start.col === b.start.col && a.end.row === b.end.row && a.end.col === b.end.col;
}

/** Makes the merged ranges of a sheet equal to `target`. */
export function reconcileMerges(workbook: Workbook, sheet: SheetId, target: readonly CellRange[]): void {
  const current = workbook.getSheet(sheet).mergedRanges;
  for (const range of current) {
    if (!target.some((wanted) => sameRange(wanted, range))) workbook.unmergeCells(sheet, range);
  }
  const left = workbook.getSheet(sheet).mergedRanges;
  for (const range of target) {
    if (!left.some((have) => sameRange(have, range))) workbook.mergeCells(sheet, range);
  }
}

function restoreNames(workbook: Workbook, names: readonly DefinedName[]): void {
  const current = workbook.listDefinedNames();
  for (const name of names) {
    const now = current.find((entry) => entry.name.toLowerCase() === name.name.toLowerCase() && entry.scope === name.scope);
    if (now === undefined || now.refersTo !== name.refersTo) workbook.setDefinedName(name);
  }
}

/**
 * Undoes an insertion: deletes the inserted rows or columns, then puts back
 * the formulas, names and sheet features the insertion rewrote.
 */
function removeInserted(internals: WorkbookInternals, step: Extract<HistoryStep, { kind: "axis"; insert: true }>): void {
  const { workbook } = internals;
  const { sheet, axis, index, count, rewritten, features } = step;
  applyAxis(workbook, sheet, axis, index, count, false);
  for (const delta of rewritten.rewrites) {
    let { row, col } = delta;
    if (delta.sheet === sheet) {
      if (axis === "row" && row >= index + count) row -= count;
      if (axis === "col" && col >= index + count) col -= count;
    }
    internals.writeRawCell(delta.sheet, { row, col }, delta.before);
  }
  restoreNames(workbook, rewritten.names);
  if (features !== null && internals.readableSheetFeatures(features)) internals.restoreSheetFeatures(sheet, features);
}

function applyAxis(workbook: Workbook, sheet: SheetId, axis: "row" | "col", index: number, count: number, insert: boolean): void {
  if (axis === "row") {
    if (insert) workbook.insertRows(sheet, index, count);
    else workbook.deleteRows(sheet, index, count);
  } else if (insert) workbook.insertColumns(sheet, index, count);
  else workbook.deleteColumns(sheet, index, count);
}

function restoreBand(
  internals: WorkbookInternals,
  step: Extract<HistoryStep, { kind: "axis"; insert: false }>,
): void {
  const { workbook } = internals;
  const { sheet, axis, index, count, band } = step;
  applyAxis(workbook, sheet, axis, index, count, true);
  for (const delta of band.rewrites) {
    let { row, col } = delta;
    if (delta.sheet === sheet) {
      if (axis === "row" && row >= index) row += count;
      if (axis === "col" && col >= index) col += count;
    }
    internals.writeRawCell(delta.sheet, { row, col }, delta.before);
  }
  for (const entry of band.cells) internals.writeRawCell(sheet, { row: entry.row, col: entry.col }, entry.cell);
  for (const size of band.sizes) {
    if (axis === "row") workbook.setRowHeight(sheet, size.index, size.size);
    else workbook.setColumnWidth(sheet, size.index, size.size);
  }
  reconcileMerges(workbook, sheet, band.merges);
  restoreNames(workbook, band.names);
  // Last, so that array formulas find their cells and rows their restored content.
  if (band.features !== null && internals.readableSheetFeatures(band.features)) internals.restoreSheetFeatures(sheet, band.features);
}

/** Applies one step. `forward` is redo; otherwise undo. */
export function applyStep(internals: WorkbookInternals, step: HistoryStep, forward: boolean): void {
  const { workbook } = internals;
  switch (step.kind) {
    case "accepted":
      if (forward) acceptAgain(internals, step.changes);
      else restoreAccepted(internals, step.changes);
      return;
    case "cells":
      for (const delta of step.deltas) {
        internals.writeRawCell(delta.sheet, { row: delta.row, col: delta.col }, forward ? delta.after : delta.before);
      }
      return;
    case "axis":
      if (step.insert) {
        if (forward) applyAxis(workbook, step.sheet, step.axis, step.index, step.count, true);
        else removeInserted(internals, step);
      }
      else if (forward) applyAxis(workbook, step.sheet, step.axis, step.index, step.count, false);
      else restoreBand(internals, step);
      return;
    case "size":
      for (const change of step.changes) {
        const size = forward ? change.after : change.before;
        if (step.axis === "row") workbook.setRowHeight(step.sheet, change.index, size);
        else workbook.setColumnWidth(step.sheet, change.index, size);
      }
      return;
    case "merges":
      reconcileMerges(workbook, step.sheet, forward ? step.after : step.before);
      return;
    case "frozen":
      workbook.setFrozenPanes(step.sheet, forward ? step.after : step.before);
      return;
    case "rename":
      workbook.renameSheet(step.sheet, forward ? step.after : step.before);
      return;
  }
}

/** Applies a whole entry: backwards for undo, forwards for redo. */
export function applyEntry(internals: WorkbookInternals, entry: HistoryEntry, forward: boolean): void {
  const steps = forward ? entry.steps : [...entry.steps].reverse();
  for (const step of steps) applyStep(internals, step, forward);
}

/** The sheets whose rows or columns an entry inserts or deletes. */
export function structuralSheets(entry: HistoryEntry): SheetId[] {
  const sheets = new Set<SheetId>();
  for (const step of entry.steps) if (step.kind === "axis") sheets.add(step.sheet);
  return [...sheets];
}

/** The smallest range on one sheet that holds every cell an entry changed, for scrolling to it. */
export function affectedRange(entry: HistoryEntry): { sheet: SheetId; start: { row: number; col: number }; end: { row: number; col: number } } | null {
  let sheet: SheetId | null = null;
  let top = Infinity;
  let left = Infinity;
  let bottom = -1;
  let right = -1;
  for (const step of entry.steps) {
    if (step.kind !== "cells") continue;
    for (const delta of step.deltas) {
      if (sheet === null) sheet = delta.sheet;
      if (delta.sheet !== sheet) continue;
      if (delta.row < top) top = delta.row;
      if (delta.row > bottom) bottom = delta.row;
      if (delta.col < left) left = delta.col;
      if (delta.col > right) right = delta.col;
    }
  }
  if (sheet === null || bottom < 0) return null;
  return { sheet, start: { row: top, col: left }, end: { row: bottom, col: right } };
}
