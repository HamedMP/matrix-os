/**
 * Checks that keep data tools from losing content under merged cells. A
 * merged cell shows only its top-left cell: a value written to any other cell
 * of it is stored but never seen, so edits that would do that are refused.
 */

import type { CellRange } from "../session/engine";

export const MERGED_CELLS = "This range has merged cells. Unmerge them first, then try again.";

function intersects(a: CellRange, b: CellRange): boolean {
  return a.start.row <= b.end.row && b.start.row <= a.end.row && a.start.col <= b.end.col && b.start.col <= a.end.col;
}

/** True when any merged range shares a cell with `range`. */
export function crossesMerge(merges: readonly CellRange[], range: CellRange): boolean {
  return merges.some((merge) => intersects(merge, range));
}

/**
 * A test for whether a cell of `area` is hidden by a merge: inside a merged
 * range but not its top-left cell. Indexed by row so a large paste does not
 * compare every cell with every merge.
 */
export function coveredIn(merges: readonly CellRange[], area: CellRange): (row: number, col: number) => boolean {
  const byRow = new Map<number, CellRange[]>();
  for (const merge of merges) {
    if (!intersects(merge, area)) continue;
    const last = Math.min(merge.end.row, area.end.row);
    for (let row = Math.max(merge.start.row, area.start.row); row <= last; row++) {
      let list = byRow.get(row);
      if (list === undefined) byRow.set(row, (list = []));
      list.push(merge);
    }
  }
  if (byRow.size === 0) return () => false;
  // Merges never overlap, so the ones on a row are ordered by their first column.
  for (const list of byRow.values()) list.sort((a, b) => a.start.col - b.start.col);
  return (row, col) => {
    const list = byRow.get(row);
    if (list === undefined) return false;
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const merge = list[mid] as CellRange;
      if (col < merge.start.col) high = mid - 1;
      else if (col > merge.end.col) low = mid + 1;
      else return row !== merge.start.row || col !== merge.start.col;
    }
    return false;
  };
}
