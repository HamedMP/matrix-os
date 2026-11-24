/**
 * Sum, average and count of the selected cells for the status bar.
 *
 * Count is the number of cells that are not empty. Sum and average take
 * numbers only, as SUM and AVERAGE over a range do: text, booleans and error
 * values are left out. A cell covered by two selected ranges counts once.
 */
import type { CellRange, SheetId } from "../session/engine";
import type { SheetSession } from "../session/session";

export interface SelectionStats {
  /** Cells holding anything. */
  count: number;
  /** Cells holding a number. */
  numericCount: number;
  sum: number;
  /** Null when no selected cell holds a number. */
  average: number | null;
  /** True when the selection was larger than the limit and only part was read. */
  truncated: boolean;
}

/** Most cells read for one summary; a larger selection reports `truncated`. */
export const STATS_CELL_LIMIT = 250_000;

/** Cuts a range to the used area of the sheet. Null when nothing of it is used. */
export function clampToUsed(range: CellRange, used: CellRange | null): CellRange | null {
  if (used === null) return null;
  const top = Math.max(range.start.row, used.start.row);
  const left = Math.max(range.start.col, used.start.col);
  const bottom = Math.min(range.end.row, used.end.row);
  const right = Math.min(range.end.col, used.end.col);
  if (top > bottom || left > right) return null;
  return { start: { row: top, col: left }, end: { row: bottom, col: right } };
}

export function selectionStats(
  session: Pick<SheetSession, "raw" | "sheet">,
  sheet: SheetId,
  ranges: readonly CellRange[],
  limit = STATS_CELL_LIMIT,
): SelectionStats {
  const used = session.sheet(sheet).dimensions;
  const clamped = ranges.map((range) => clampToUsed(range, used)).filter((range): range is CellRange => range !== null);
  const seen = clamped.length > 1 ? new Set<number>() : null;
  let count = 0;
  let numericCount = 0;
  let sum = 0;
  let read = 0;
  let truncated = false;
  outer: for (const range of clamped) {
    for (let row = range.start.row; row <= range.end.row; row++) {
      for (let col = range.start.col; col <= range.end.col; col++) {
        if (read >= limit) {
          truncated = true;
          break outer;
        }
        read++;
        if (seen !== null) {
          // Rows and columns stay below 2^20 and 2^14, so this key is unique and exact.
          const key = row * 16_384 + col;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        const cell = session.raw(sheet, row, col);
        const value = cell.value;
        if (value === null && cell.formula === null) continue;
        if (value === null || value === "") continue;
        count++;
        if (typeof value === "number" && Number.isFinite(value)) {
          numericCount++;
          sum += value;
        }
      }
    }
  }
  return { count, numericCount, sum, average: numericCount === 0 ? null : sum / numericCount, truncated };
}

/** A number for the status bar: grouped, at most ten significant digits. */
export function formatStat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(10));
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 10 });
}
