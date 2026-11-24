/**
 * Moving the active cell with the keyboard: one step, to the edge of a block
 * of data (Ctrl with an arrow), by a page, to the start or end.
 */

import { type CellAddress, type CellRange, MAX_COLS, MAX_ROWS } from "../session/engine";
import { mergeAt } from "./selection";

export type Direction = "up" | "down" | "left" | "right";

export interface NavContext {
  /** Merged ranges of the sheet. */
  merges: readonly CellRange[];
  /** The used area of the sheet, or null when it is empty. */
  used: CellRange | null;
  /** True for a cell without value and formula. Called only inside `used`. */
  isBlank(row: number, col: number): boolean;
  /** True for a row or column that is hidden (zero size). */
  isRowHidden(row: number): boolean;
  isColHidden(col: number): boolean;
}

const LAST_ROW = MAX_ROWS - 1;
const LAST_COL = MAX_COLS - 1;
/** Hidden rows or columns skipped in one step before giving up. */
const MAX_HIDDEN_RUN = 1_100_000;

const DELTA: Record<Direction, { row: number; col: number }> = {
  up: { row: -1, col: 0 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
  right: { row: 0, col: 1 },
};

function inSheet(row: number, col: number): boolean {
  return row >= 0 && row <= LAST_ROW && col >= 0 && col <= LAST_COL;
}

/**
 * One step in a direction. Leaves a merged range in one step, lands on the
 * first cell of a merged range, and skips hidden rows and columns. Stays put
 * at the edge of the sheet.
 */
export function step(from: CellAddress, direction: Direction, context: NavContext): CellAddress {
  const delta = DELTA[direction];
  const here = mergeAt(context.merges, from.row, from.col);
  let row = from.row;
  let col = from.col;
  if (here !== null) {
    if (direction === "down") row = here.end.row;
    if (direction === "up") row = here.start.row;
    if (direction === "right") col = here.end.col;
    if (direction === "left") col = here.start.col;
  }
  for (let guard = 0; guard < MAX_HIDDEN_RUN; guard++) {
    row += delta.row;
    col += delta.col;
    if (!inSheet(row, col)) return from;
    if (delta.row !== 0 ? !context.isRowHidden(row) : !context.isColHidden(col)) break;
  }
  const target = mergeAt(context.merges, row, col);
  return target === null ? { row, col } : { ...target.start };
}

/**
 * The cell Ctrl with an arrow goes to: the last cell of the block of data the
 * cell is in, or the first cell with data after a gap, or the edge of the
 * sheet when there is no more data that way.
 */
export function jump(from: CellAddress, direction: Direction, context: NavContext): CellAddress {
  const delta = DELTA[direction];
  const vertical = delta.row !== 0;
  const forward = delta.row + delta.col > 0;
  const edge = vertical ? (forward ? LAST_ROW : 0) : forward ? LAST_COL : 0;
  const result = (position: number): CellAddress => (vertical ? { row: position, col: from.col } : { row: from.row, col: position });
  const used = context.used;
  if (used === null) return result(edge);
  // Outside the used area on the other axis there is no data in this line at all.
  if (vertical ? from.col < used.start.col || from.col > used.end.col : from.row < used.start.row || from.row > used.end.row) {
    return result(edge);
  }
  const first = vertical ? used.start.row : used.start.col;
  const last = vertical ? used.end.row : used.end.col;
  const blank = (position: number): boolean => {
    if (position < first || position > last) return true;
    return vertical ? context.isBlank(position, from.col) : context.isBlank(from.row, position);
  };
  const stepBy = forward ? 1 : -1;
  const limit = forward ? last : first;
  const beyond = (position: number): boolean => (forward ? position > limit : position < limit);
  let position = vertical ? from.row : from.col;
  if (beyond(position + stepBy)) return result(edge);
  if (!blank(position) && !blank(position + stepBy)) {
    while (!beyond(position + stepBy) && !blank(position + stepBy)) position += stepBy;
    return result(position);
  }
  position += stepBy;
  while (!beyond(position) && blank(position)) position += stepBy;
  return result(beyond(position) ? edge : position);
}

/** Moves by a number of rows, staying in the sheet and off hidden rows. */
export function moveRows(from: CellAddress, rows: number, context: NavContext): CellAddress {
  let row = Math.min(LAST_ROW, Math.max(0, from.row + rows));
  const back = rows > 0 ? -1 : 1;
  for (let guard = 0; guard < MAX_HIDDEN_RUN && context.isRowHidden(row) && row !== from.row; guard++) row += back;
  return { row, col: from.col };
}

/** The last cell of the used area (Ctrl+End), or A1 for an empty sheet. */
export function lastUsedCell(context: NavContext): CellAddress {
  return context.used === null ? { row: 0, col: 0 } : { ...context.used.end };
}
