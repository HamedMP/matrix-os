/**
 * The selection model: pure functions over plain data.
 *
 * A selection is a list of ranges (the last one is the range being worked
 * on), the active cell (where typing goes) and two corners of the last
 * range: the anchor stays put, the focus moves when the range is extended.
 * A range can also stand for whole rows, whole columns or the whole sheet.
 */

import { type CellAddress, type CellRange, MAX_COLS, MAX_ROWS } from "../session/engine";

export type RangeKind = "cells" | "rows" | "cols" | "all";

export interface SelRange extends CellRange {
  kind: RangeKind;
}

export interface Selection {
  ranges: SelRange[];
  active: CellAddress;
  anchor: CellAddress;
  focus: CellAddress;
}

const LAST_ROW = MAX_ROWS - 1;
const LAST_COL = MAX_COLS - 1;

export function clampCell(cell: CellAddress): CellAddress {
  return {
    row: Math.min(LAST_ROW, Math.max(0, Math.trunc(cell.row))),
    col: Math.min(LAST_COL, Math.max(0, Math.trunc(cell.col))),
  };
}

export function sameCell(a: CellAddress, b: CellAddress): boolean {
  return a.row === b.row && a.col === b.col;
}

export function sameRange(a: CellRange, b: CellRange): boolean {
  return sameCell(a.start, b.start) && sameCell(a.end, b.end);
}

/** The rectangle with the two cells as corners. */
export function boundingRange(a: CellAddress, b: CellAddress): CellRange {
  return {
    start: { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) },
    end: { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) },
  };
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  return row >= range.start.row && row <= range.end.row && col >= range.start.col && col <= range.end.col;
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  return a.start.row <= b.end.row && b.start.row <= a.end.row && a.start.col <= b.end.col && b.start.col <= a.end.col;
}

export function intersectRanges(a: CellRange, b: CellRange): CellRange | null {
  if (!rangesIntersect(a, b)) return null;
  return {
    start: { row: Math.max(a.start.row, b.start.row), col: Math.max(a.start.col, b.start.col) },
    end: { row: Math.min(a.end.row, b.end.row), col: Math.min(a.end.col, b.end.col) },
  };
}

export function rangeRows(range: CellRange): number {
  return range.end.row - range.start.row + 1;
}

export function rangeCols(range: CellRange): number {
  return range.end.col - range.start.col + 1;
}

/** The merged range that holds a cell, or null. */
export function mergeAt(merges: readonly CellRange[], row: number, col: number): CellRange | null {
  for (const merge of merges) if (rangeContains(merge, row, col)) return merge;
  return null;
}

/** Grows a range until no merged range crosses its border. */
export function expandToMerges(range: CellRange, merges: readonly CellRange[]): CellRange {
  if (merges.length === 0) return range;
  let current = range;
  for (let pass = 0; pass < 64; pass++) {
    let grown = current;
    for (const merge of merges) {
      if (!rangesIntersect(grown, merge)) continue;
      grown = {
        start: { row: Math.min(grown.start.row, merge.start.row), col: Math.min(grown.start.col, merge.start.col) },
        end: { row: Math.max(grown.end.row, merge.end.row), col: Math.max(grown.end.col, merge.end.col) },
      };
    }
    if (sameRange(grown, current)) return current;
    current = grown;
  }
  return current;
}

/** Selects one cell. Inside a merged range the whole merge is selected and its first cell is active. */
export function selectCell(cell: CellAddress, merges: readonly CellRange[] = []): Selection {
  const at = clampCell(cell);
  const merge = mergeAt(merges, at.row, at.col);
  const active = merge === null ? at : { ...merge.start };
  const range = merge === null ? { start: at, end: at } : merge;
  return { ranges: [{ start: { ...range.start }, end: { ...range.end }, kind: "cells" }], active, anchor: active, focus: at };
}

/** Extends the last range from the anchor to `cell` (shift-click, shift-arrow, drag). */
export function extendTo(selection: Selection, cell: CellAddress, merges: readonly CellRange[] = []): Selection {
  const focus = clampCell(cell);
  const last = selection.ranges[selection.ranges.length - 1];
  const kind = last?.kind ?? "cells";
  let range: SelRange;
  if (kind === "rows") {
    const span = boundingRange(selection.anchor, focus);
    range = { start: { row: span.start.row, col: 0 }, end: { row: span.end.row, col: LAST_COL }, kind };
  } else if (kind === "cols") {
    const span = boundingRange(selection.anchor, focus);
    range = { start: { row: 0, col: span.start.col }, end: { row: LAST_ROW, col: span.end.col }, kind };
  } else {
    range = { ...expandToMerges(boundingRange(selection.anchor, focus), merges), kind: "cells" };
  }
  return { ranges: [...selection.ranges.slice(0, -1), range], active: selection.anchor, anchor: selection.anchor, focus };
}

/** Starts another range at `cell` and keeps the others (ctrl-click). */
export function addCell(selection: Selection, cell: CellAddress, merges: readonly CellRange[] = []): Selection {
  const single = selectCell(cell, merges);
  return { ...single, ranges: [...selection.ranges, ...single.ranges] };
}

export type SelectMode = "replace" | "extend" | "add";

/** Selects whole rows. `extend` runs from the anchor row to `row`; `add` keeps the other ranges. */
export function selectRows(selection: Selection | null, row: number, mode: SelectMode = "replace", firstCol = 0): Selection {
  const target = clampCell({ row, col: firstCol });
  if (mode === "extend" && selection !== null) {
    const base: Selection = { ...selection, ranges: [...selection.ranges.slice(0, -1), { ...whole("rows", selection.anchor.row), kind: "rows" }] };
    return extendTo(base, target);
  }
  const range = whole("rows", target.row);
  const kept = mode === "add" && selection !== null ? selection.ranges : [];
  return { ranges: [...kept, range], active: target, anchor: target, focus: target };
}

/** Selects whole columns. */
export function selectColumns(selection: Selection | null, col: number, mode: SelectMode = "replace", firstRow = 0): Selection {
  const target = clampCell({ row: firstRow, col });
  if (mode === "extend" && selection !== null) {
    const base: Selection = { ...selection, ranges: [...selection.ranges.slice(0, -1), { ...whole("cols", selection.anchor.col), kind: "cols" }] };
    return extendTo(base, target);
  }
  const range = whole("cols", target.col);
  const kept = mode === "add" && selection !== null ? selection.ranges : [];
  return { ranges: [...kept, range], active: target, anchor: target, focus: target };
}

function whole(kind: "rows" | "cols", index: number): SelRange {
  return kind === "rows"
    ? { start: { row: index, col: 0 }, end: { row: index, col: LAST_COL }, kind }
    : { start: { row: 0, col: index }, end: { row: LAST_ROW, col: index }, kind };
}

/** Selects the whole sheet and keeps the active cell. */
export function selectAll(active: CellAddress = { row: 0, col: 0 }): Selection {
  const at = clampCell(active);
  return { ranges: [{ start: { row: 0, col: 0 }, end: { row: LAST_ROW, col: LAST_COL }, kind: "all" }], active: at, anchor: at, focus: at };
}

/** The range being worked on. */
export function activeRange(selection: Selection): SelRange {
  const last = selection.ranges[selection.ranges.length - 1];
  return last ?? { start: selection.active, end: selection.active, kind: "cells" };
}

export function isSingleCell(selection: Selection, merges: readonly CellRange[] = []): boolean {
  if (selection.ranges.length !== 1) return false;
  const range = activeRange(selection);
  if (sameCell(range.start, range.end)) return true;
  const merge = mergeAt(merges, selection.active.row, selection.active.col);
  return merge !== null && sameRange(merge, range);
}

export function selectionContains(selection: Selection, row: number, col: number): boolean {
  for (const range of selection.ranges) if (rangeContains(range, row, col)) return true;
  return false;
}

/** True when every column of the row is selected (the row header shows as selected). */
export function rowFullySelected(selection: Selection, row: number): boolean {
  return selection.ranges.some((range) => (range.kind === "rows" || range.kind === "all") && row >= range.start.row && row <= range.end.row);
}

export function columnFullySelected(selection: Selection, col: number): boolean {
  return selection.ranges.some((range) => (range.kind === "cols" || range.kind === "all") && col >= range.start.col && col <= range.end.col);
}

/** True when any selected range touches the row (the header is highlighted). */
export function rowTouched(selection: Selection, row: number): boolean {
  return selection.ranges.some((range) => row >= range.start.row && row <= range.end.row);
}

export function columnTouched(selection: Selection, col: number): boolean {
  return selection.ranges.some((range) => col >= range.start.col && col <= range.end.col);
}

/** Rows and columns that are off screen: hidden by a filter, or given no size. */
export interface HiddenLines {
  isRowHidden(row: number): boolean;
  isColHidden(col: number): boolean;
}

const NOTHING_HIDDEN: HiddenLines = { isRowHidden: () => false, isColHidden: () => false };

/**
 * Moves the active cell inside a selection of more than one cell, as Tab and
 * Enter do: `right` and `left` go through each range row by row, `down` and
 * `up` column by column, wrapping to the next range at the end. Cells in
 * hidden rows or columns, and cells hidden inside a merged range, are
 * skipped, as one step outside a selection skips them. The active cell stays
 * where it is when no other selected cell is on screen. The ranges do not
 * change.
 */
export function moveWithinSelection(
  selection: Selection,
  direction: "right" | "left" | "down" | "up",
  merges: readonly CellRange[] = [],
  hidden: HiddenLines = NOTHING_HIDDEN,
): Selection {
  const ranges = selection.ranges;
  if (ranges.length === 0) return selection;
  let index = ranges.findIndex((range) => rangeContains(range, selection.active.row, selection.active.col));
  if (index < 0) index = ranges.length - 1;
  const forward = direction === "right" || direction === "down";
  const by = forward ? 1 : -1;
  // `right` and `left` step along a row (the position is the column) and wrap to the next row (the line).
  const byRow = direction === "right" || direction === "left";
  const lineHidden = byRow ? hidden.isRowHidden : hidden.isColHidden;
  const posHidden = byRow ? hidden.isColHidden : hidden.isRowHidden;
  const lines = (range: CellRange): [number, number] => (byRow ? [range.start.row, range.end.row] : [range.start.col, range.end.col]);
  const positions = (range: CellRange): [number, number] => (byRow ? [range.start.col, range.end.col] : [range.start.row, range.end.row]);
  // Skips a run of hidden lines or positions; bounded by the range, so a long hidden run costs no guard step.
  const skip = (from: number, isHidden: (index: number) => boolean, [first, last]: [number, number]): number | null => {
    let at = from;
    while (at >= first && at <= last && isHidden(at)) at += by;
    return at >= first && at <= last ? at : null;
  };
  const firstIn = (range: CellRange): [number, number] | null => {
    const [lineFirst, lineLast] = lines(range);
    const [posFirst, posLast] = positions(range);
    const line = skip(forward ? lineFirst : lineLast, lineHidden, [lineFirst, lineLast]);
    const pos = skip(forward ? posFirst : posLast, posHidden, [posFirst, posLast]);
    return line === null || pos === null ? null : [line, pos];
  };
  const nextIn = (range: CellRange, line: number, pos: number): [number, number] | null => {
    const span = positions(range);
    const along = lineHidden(line) ? null : skip(pos + by, posHidden, span);
    if (along !== null) return [line, along];
    const nextLine = skip(line + by, lineHidden, lines(range));
    const first = skip(forward ? span[0] : span[1], posHidden, span);
    return nextLine === null || first === null ? null : [nextLine, first];
  };
  let line = byRow ? selection.active.row : selection.active.col;
  let pos = byRow ? selection.active.col : selection.active.row;
  const total = ranges.reduce((sum, range) => sum + Math.min(1_000_000, rangeRows(range) * rangeCols(range)), 0);
  for (let guard = 0; guard < Math.min(total, 10_000) + 1; guard++) {
    let next = nextIn(ranges[index] as SelRange, line, pos);
    for (let tried = 0; next === null && tried < ranges.length; tried++) {
      index = (index + (forward ? 1 : ranges.length - 1)) % ranges.length;
      next = firstIn(ranges[index] as SelRange);
    }
    if (next === null) return selection;
    [line, pos] = next;
    const row = byRow ? line : pos;
    const col = byRow ? pos : line;
    const merge = mergeAt(merges, row, col);
    if (merge === null || (merge.start.row === row && merge.start.col === col)) break;
  }
  return { ...selection, active: byRow ? { row: line, col: pos } : { row: pos, col: line } };
}

/** Cuts every range to the rows and columns in use, so that work on a whole column stays bounded. Ranges outside are dropped. */
export function clipToUsed(ranges: readonly CellRange[], used: CellRange | null): CellRange[] {
  if (used === null) return [];
  const out: CellRange[] = [];
  for (const range of ranges) {
    const cut = intersectRanges(range, used);
    if (cut !== null) out.push(cut);
  }
  return out;
}
