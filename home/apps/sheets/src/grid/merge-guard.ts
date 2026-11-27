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

/** The merge of `list` (sorted by first column, none sharing a column) that holds `col`. */
function holding(list: readonly CellRange[], col: number): CellRange | undefined {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const merge = list[mid] as CellRange;
    if (col < merge.start.col) high = mid - 1;
    else if (col > merge.end.col) low = mid + 1;
    else return merge;
  }
  return undefined;
}

/** First index of the sorted `points` greater than `value`. */
function upper(points: readonly number[], value: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((points[mid] as number) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * A test for whether a cell of `area` is hidden by a merge: inside a merged
 * range but not its top-left cell.
 *
 * The merges go into a segment tree over their row spans: each merge is
 * stored in a few nodes, so building costs about merges × log(merges) however
 * many rows a merge spans, and each test walks one path of the tree.
 */
export function coveredIn(merges: readonly CellRange[], area: CellRange): (row: number, col: number) => boolean {
  const kept = merges.filter((merge) => intersects(merge, area));
  if (kept.length === 0) return () => false;
  // Row spans become runs between consecutive points: a merge covers whole runs.
  const points = [...new Set(kept.flatMap((merge) => [merge.start.row, merge.end.row + 1]))].sort((a, b) => a - b);
  const runs = points.length - 1;
  const nodes = new Map<number, CellRange[]>();
  const insert = (node: number, low: number, high: number, from: number, to: number, merge: CellRange): void => {
    if (to < low || high < from) return;
    if (from <= low && high <= to) {
      let list = nodes.get(node);
      if (list === undefined) nodes.set(node, (list = []));
      list.push(merge);
      return;
    }
    const mid = (low + high) >>> 1;
    insert(node * 2, low, mid, from, to, merge);
    insert(node * 2 + 1, mid + 1, high, from, to, merge);
  };
  for (const merge of kept) {
    insert(1, 0, runs - 1, upper(points, merge.start.row) - 1, upper(points, merge.end.row) - 1, merge);
  }
  // The merges of one node all span the node's rows, and merges never overlap, so they never share a column.
  for (const list of nodes.values()) list.sort((a, b) => a.start.col - b.start.col);
  return (row, col) => {
    const run = upper(points, row) - 1;
    if (run < 0 || run >= runs) return false;
    let node = 1;
    let low = 0;
    let high = runs - 1;
    for (;;) {
      const list = nodes.get(node);
      const merge = list === undefined ? undefined : holding(list, col);
      if (merge !== undefined) return row !== merge.start.row || col !== merge.start.col;
      if (low === high) return false;
      const mid = (low + high) >>> 1;
      if (run <= mid) {
        node = node * 2;
        high = mid;
      } else {
        node = node * 2 + 1;
        low = mid + 1;
      }
    }
  };
}
