/**
 * The rows a filter leaves on screen.
 *
 * A filter hides rows in this view only. Actions the owner starts on a
 * selection (clear, copy, fill, paste) act on the rows they can see, so a
 * hidden row is never changed or copied by accident.
 */

import { MAX_ROWS, type CellRange } from "../session/engine";
import type { GridContext } from "./context";

/** The rows the active filter hides, or null when nothing is hidden. */
export function hiddenRows(ctx: GridContext): ReadonlySet<number> | null {
  return ctx.layout().hiddenRows;
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
