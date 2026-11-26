/**
 * The rows a filter leaves on screen.
 *
 * A filter hides rows in this view only. Actions the owner starts on a
 * selection (clear, copy, fill, paste) act on the rows they can see, so a
 * hidden row is never changed or copied by accident.
 */

import { MAX_ROWS, type CellRange, type SheetId } from "../session/engine";
import type { GridContext } from "./context";
import { fillFromEdge } from "./fill";

/** The rows the active filter hides, or null when nothing is hidden. */
export function hiddenRows(ctx: GridContext): ReadonlySet<number> | null {
  return ctx.layout().hiddenRows;
}

/** The rows the filter of any sheet hides in this view, or null when nothing is hidden. */
export function hiddenIn(ctx: GridContext, sheet: SheetId): ReadonlySet<number> | null {
  if (sheet === ctx.sheet) return hiddenRows(ctx);
  const hidden = ctx.store.view(sheet).filter?.hidden ?? null;
  return hidden === null || hidden.length === 0 ? null : new Set(hidden);
}

/** The visible rows from `first` to `last`, in order. */
export function visibleRowsIn(first: number, last: number, hidden: ReadonlySet<number> | null): number[] {
  const rows: number[] = [];
  for (let row = first; row <= last; row++) if (hidden === null || !hidden.has(row)) rows.push(row);
  return rows;
}

/** The next `count` visible rows starting at `start`, stopping at the end of the sheet. */
export function visibleRowsFrom(start: number, count: number, hidden: ReadonlySet<number> | null): number[] {
  const rows: number[] = [];
  for (let row = start; rows.length < count && row < MAX_ROWS; row++) if (hidden === null || !hidden.has(row)) rows.push(row);
  return rows;
}

/** True when the rows follow each other with no gap. */
export function contiguous(rows: readonly number[]): boolean {
  return rows.length === 0 || (rows[rows.length - 1] as number) - (rows[0] as number) === rows.length - 1;
}

/** A range cut into the runs of rows that are visible. */
export function visibleRuns(range: CellRange, hidden: ReadonlySet<number> | null): CellRange[] {
  if (hidden === null) return [range];
  const runs: CellRange[] = [];
  let start = -1;
  for (let row = range.start.row; row <= range.end.row + 1; row++) {
    const visible = row <= range.end.row && !hidden.has(row);
    if (visible && start < 0) start = row;
    if (!visible && start >= 0) {
      runs.push({ start: { row: start, col: range.start.col }, end: { row: row - 1, col: range.end.col } });
      start = -1;
    }
  }
  return runs;
}

/**
 * The rows Ctrl+D works on when a filter hides some: from the first to the
 * last visible row of the range, and for one row, the visible row above it
 * as the source. Null when no row of the range is visible or none above it.
 */
export function visibleFillDown(range: CellRange, hidden: ReadonlySet<number> | null): { source: CellRange; target: CellRange } | null {
  if (hidden === null) return fillFromEdge(range, "down");
  let first = range.start.row;
  while (first <= range.end.row && hidden.has(first)) first++;
  let last = range.end.row;
  while (last >= first && hidden.has(last)) last--;
  if (first > last) return null;
  const rows = (start: number, end: number): CellRange => ({ start: { row: start, col: range.start.col }, end: { row: end, col: range.end.col } });
  if (last > first) return { source: rows(first, first), target: rows(first + 1, last) };
  let above = first - 1;
  while (above >= 0 && hidden.has(above)) above--;
  return above < 0 ? null : { source: rows(above, above), target: rows(first, first) };
}
