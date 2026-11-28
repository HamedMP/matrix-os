/**
 * What the deterministic checks ask about many cells of one sheet, worked out
 * once per sheet in passes over its cells, so a check costs the same however
 * long the column or row it looks along is.
 *
 * - Labels: the nearest text to the left of a cell (its row label) and above
 *   it (its column header).
 * - Runs: the count and sum of the numbers directly before a cell, up its
 *   column or left along its row.
 * - Lines: where the next or previous counted number is along a column or
 *   row, and where a walk through non-empty, non-text cells stops. Built on
 *   first use, only for a sheet with a `SUM` to check.
 */

import type { Cell } from "./engine";
import { type SheetCells, isBlank, isNumber, isText } from "./sheet-read";

export type LineAxis = "col" | "row";

interface Lines {
  /** Per cell: the index along its axis of the next counted number at or after it, or the axis length. */
  nextDown: Int32Array;
  nextRight: Int32Array;
  /** Per cell: the index of the previous counted number at or before it, or -1. */
  prevUp: Int32Array;
  prevLeft: Int32Array;
  /** Per cell: the index of the nearest text or empty cell at or before it, or -1. */
  stopUp: Int32Array;
  stopLeft: Int32Array;
}

export class SheetIndex {
  private readonly left: Array<string | null>;
  private readonly above: Array<string | null>;
  private runs: { upCells: Int32Array; upSum: Float64Array; leftCells: Int32Array; leftSum: Float64Array } | null = null;
  private lines: Lines | null = null;

  /** `counted` says which numbers a `SUM` should not leave out (dates are not). */
  constructor(
    readonly data: SheetCells,
    private readonly counted: (cell: Cell) => boolean,
  ) {
    const { rows, cols } = data;
    this.left = new Array<string | null>(rows * cols).fill(null);
    this.above = new Array<string | null>(rows * cols).fill(null);
    const headers = new Array<string | null>(cols).fill(null);
    for (let r = 0; r < rows; r++) {
      const line = data.cells[r] ?? [];
      let label: string | null = null;
      for (let c = 0; c < cols; c++) {
        const at = r * cols + c;
        this.left[at] = label;
        this.above[at] = headers[c] ?? null;
        const cell = line[c] ?? null;
        if (isText(cell)) {
          const text = String(cell.value).trim();
          label = text;
          headers[c] = text;
        }
      }
    }
  }

  /** The flat index of a sheet address, or -1 outside the used range. */
  private at(row: number, col: number): number {
    const r = row - this.data.origin.row;
    const c = col - this.data.origin.col;
    if (r < 0 || c < 0 || r >= this.data.rows || c >= this.data.cols) return -1;
    return r * this.data.cols + c;
  }

  private cell(r: number, c: number): Cell | null {
    return this.data.cells[r]?.[c] ?? null;
  }

  /** The nearest text to the left in the row, skipping numbers: the row's label. */
  rowLabel(row: number, col: number): string | null {
    const at = this.at(row, col);
    return at < 0 ? null : (this.left[at] ?? null);
  }

  /** The nearest text above in the column, skipping numbers: the column's header. */
  columnHeader(row: number, col: number): string | null {
    const at = this.at(row, col);
    return at < 0 ? null : (this.above[at] ?? null);
  }

  /** Sum of the contiguous numbers before a cell, up its column or left along its row, or null when fewer than two. */
  runBefore(row: number, col: number, axis: LineAxis): { sum: number; cells: number } | null {
    const at = this.at(row, col);
    if (at < 0) return null;
    const runs = this.buildRuns();
    const cells = axis === "col" ? (runs.upCells[at] ?? 0) : (runs.leftCells[at] ?? 0);
    if (cells < 2) return null;
    return { sum: axis === "col" ? (runs.upSum[at] ?? 0) : (runs.leftSum[at] ?? 0), cells };
  }

  /**
   * Sheet indexes along a line (a column when `axis` is "col") of the counted
   * numbers from `from` to `to`, in order, at most `max` of them.
   */
  countedBetween(axis: LineAxis, line: number, from: number, to: number, max: number): number[] {
    const { origin, rows, cols } = this.data;
    const fixed = axis === "col" ? line - origin.col : line - origin.row;
    const length = axis === "col" ? rows : cols;
    const base = axis === "col" ? origin.row : origin.col;
    if (fixed < 0 || fixed >= (axis === "col" ? cols : rows)) return [];
    const lines = this.buildLines();
    const next = axis === "col" ? lines.nextDown : lines.nextRight;
    const flat = (i: number): number => (axis === "col" ? i * cols + fixed : fixed * cols + i);
    const out: number[] = [];
    let i = Math.max(0, from - base);
    const last = Math.min(length - 1, to - base);
    while (i <= last && out.length < max) {
      i = next[flat(i)] ?? length;
      if (i > last) break;
      out.push(base + i);
      i += 1;
    }
    return out;
  }

  /**
   * Walking back along a line from `from` through cells that hold something
   * other than text, the sheet indexes of the counted numbers passed, nearest
   * first, at most `max` of them.
   */
  countedBackToText(axis: LineAxis, line: number, from: number, max: number): number[] {
    const { origin, rows, cols } = this.data;
    const fixed = axis === "col" ? line - origin.col : line - origin.row;
    const length = axis === "col" ? rows : cols;
    const base = axis === "col" ? origin.row : origin.col;
    let i = from - base;
    if (fixed < 0 || fixed >= (axis === "col" ? cols : rows) || i < 0 || i >= length) return [];
    const lines = this.buildLines();
    const prev = axis === "col" ? lines.prevUp : lines.prevLeft;
    const stops = axis === "col" ? lines.stopUp : lines.stopLeft;
    const flat = (k: number): number => (axis === "col" ? k * cols + fixed : fixed * cols + k);
    const stop = stops[flat(i)] ?? -1;
    const out: number[] = [];
    while (i > stop && out.length < max) {
      i = prev[flat(i)] ?? -1;
      if (i <= stop) break;
      out.push(base + i);
      i -= 1;
    }
    return out;
  }

  private buildRuns(): NonNullable<SheetIndex["runs"]> {
    if (this.runs !== null) return this.runs;
    const { rows, cols } = this.data;
    const upCells = new Int32Array(rows * cols);
    const upSum = new Float64Array(rows * cols);
    const leftCells = new Int32Array(rows * cols);
    const leftSum = new Float64Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const at = r * cols + c;
        if (r > 0) {
          const before = this.cell(r - 1, c);
          if (isNumber(before)) {
            upCells[at] = (upCells[at - cols] ?? 0) + 1;
            upSum[at] = (upSum[at - cols] ?? 0) + before.value;
          }
        }
        if (c > 0) {
          const before = this.cell(r, c - 1);
          if (isNumber(before)) {
            leftCells[at] = (leftCells[at - 1] ?? 0) + 1;
            leftSum[at] = (leftSum[at - 1] ?? 0) + before.value;
          }
        }
      }
    }
    this.runs = { upCells, upSum, leftCells, leftSum };
    return this.runs;
  }

  private buildLines(): Lines {
    if (this.lines !== null) return this.lines;
    const { rows, cols } = this.data;
    const size = rows * cols;
    const lines: Lines = {
      nextDown: new Int32Array(size),
      nextRight: new Int32Array(size),
      prevUp: new Int32Array(size),
      prevLeft: new Int32Array(size),
      stopUp: new Int32Array(size),
      stopLeft: new Int32Array(size),
    };
    const countedAt = new Uint8Array(size);
    const stopAt = new Uint8Array(size);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = this.cell(r, c);
        const at = r * cols + c;
        if (isNumber(cell) && this.counted(cell)) countedAt[at] = 1;
        if (isText(cell) || isBlank(cell)) stopAt[at] = 1;
      }
    }
    for (let c = 0; c < cols; c++) {
      let prev = -1;
      let stop = -1;
      for (let r = 0; r < rows; r++) {
        const at = r * cols + c;
        if (countedAt[at] === 1) prev = r;
        if (stopAt[at] === 1) stop = r;
        lines.prevUp[at] = prev;
        lines.stopUp[at] = stop;
      }
      let next = rows;
      for (let r = rows - 1; r >= 0; r--) {
        const at = r * cols + c;
        if (countedAt[at] === 1) next = r;
        lines.nextDown[at] = next;
      }
    }
    for (let r = 0; r < rows; r++) {
      let prev = -1;
      let stop = -1;
      for (let c = 0; c < cols; c++) {
        const at = r * cols + c;
        if (countedAt[at] === 1) prev = c;
        if (stopAt[at] === 1) stop = c;
        lines.prevLeft[at] = prev;
        lines.stopLeft[at] = stop;
      }
      let next = cols;
      for (let c = cols - 1; c >= 0; c--) {
        const at = r * cols + c;
        if (countedAt[at] === 1) next = c;
        lines.nextRight[at] = next;
      }
    }
    this.lines = lines;
    return lines;
  }
}
