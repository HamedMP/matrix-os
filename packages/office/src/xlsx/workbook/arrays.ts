/**
 * The ranges array formulas fill, per sheet, and the rule that protects them.
 *
 * An array formula sits in the first cell of its range and the calculation
 * fills the rest. A cell of such a range is not edited on its own: an edit
 * either covers the whole range, which removes the formula, or is refused.
 * Inside a proposal it is always refused, because the journal keeps value,
 * formula and style of a cell and could not put an array formula back.
 */

import type { CellRange } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { arrayFormulaRange } from "./calc-graph.js";
import type { SheetModel, WorkbookState } from "./model.js";

/** Rows per bucket of the lookup index. */
const BLOCK_BITS = 8;

interface ArrayIndex {
  ranges: CellRange[];
  /** Ranges by the row blocks they touch. Bounded: a range spans at most 100 000 rows. */
  blocks: Map<number, CellRange[]>;
}

/** One index per sheet, rebuilt after an array formula or the structure of the sheet changed. */
const indexes = new WeakMap<SheetModel, ArrayIndex>();

/** Forgets the ranges of a sheet; the next question scans the sheet again. */
export function invalidateArrayRanges(sheet: SheetModel): void {
  indexes.delete(sheet);
}

function indexOf(sheet: SheetModel): ArrayIndex {
  let index = indexes.get(sheet);
  if (index !== undefined) return index;
  index = { ranges: [], blocks: new Map() };
  for (const row of sheet.rows.values()) {
    for (const [col, cell] of row.cells) {
      if (cell.extra === null) continue;
      const range = arrayFormulaRange(cell, row.index, col);
      if (range === null) continue;
      index.ranges.push(range);
      for (let block = range.start.row >> BLOCK_BITS; block <= range.end.row >> BLOCK_BITS; block++) {
        const list = index.blocks.get(block);
        if (list === undefined) index.blocks.set(block, [range]);
        else list.push(range);
      }
    }
  }
  indexes.set(sheet, index);
  return index;
}

function contains(range: CellRange, row: number, col: number): boolean {
  return row >= range.start.row && row <= range.end.row && col >= range.start.col && col <= range.end.col;
}

/** The range of the array formula that fills the cell, the formula's own cell included, or null. */
export function arrayRangeAt(sheet: SheetModel, row: number, col: number): CellRange | null {
  const index = indexOf(sheet);
  if (index.ranges.length === 0) return null;
  const list = index.blocks.get(row >> BLOCK_BITS);
  if (list === undefined) return null;
  for (const range of list) if (contains(range, row, col)) return range;
  return null;
}

/** The array formula ranges that meet a rectangle. */
function rangesTouching(index: ArrayIndex, bounds: CellRange): CellRange[] {
  const meets = (range: CellRange): boolean =>
    range.start.row <= bounds.end.row && range.end.row >= bounds.start.row && range.start.col <= bounds.end.col && range.end.col >= bounds.start.col;
  const firstBlock = bounds.start.row >> BLOCK_BITS;
  const lastBlock = bounds.end.row >> BLOCK_BITS;
  if (lastBlock - firstBlock + 1 >= index.blocks.size) return index.ranges.filter(meets);
  const found = new Set<CellRange>();
  for (let block = firstBlock; block <= lastBlock; block++) {
    for (const range of index.blocks.get(block) ?? []) if (meets(range)) found.add(range);
  }
  return [...found];
}

/**
 * Checks a content edit before it touches a cell. `bounds` is the smallest
 * rectangle around the cells to be written; `covers` says which cells of it
 * are written, or is null when all of them are.
 *
 * Throws `invalid_operation` when the edit would change part of an array
 * formula's range, or any of it while a proposal is open.
 */
export function guardArrayWrite(
  state: WorkbookState,
  sheet: SheetModel,
  bounds: CellRange,
  covers: ((row: number, col: number) => boolean) | null,
): void {
  const index = indexOf(sheet);
  if (index.ranges.length === 0) return;
  for (const range of rangesTouching(index, bounds)) {
    let whole =
      range.start.row >= bounds.start.row && range.end.row <= bounds.end.row && range.start.col >= bounds.start.col && range.end.col <= bounds.end.col;
    if (whole && covers !== null) {
      for (let row = range.start.row; whole && row <= range.end.row; row++) {
        for (let col = range.start.col; col <= range.end.col; col++) {
          if (!covers(row, col)) {
            whole = false;
            break;
          }
        }
      }
    }
    if (!whole) {
      throw new OfficeError("invalid_operation", "the cell is part of an array formula; change the whole range of the formula instead");
    }
    if (state.journal?.proposalOpen?.() === true) {
      throw new OfficeError("invalid_operation", "an array formula cannot be changed inside a proposal");
    }
  }
}
