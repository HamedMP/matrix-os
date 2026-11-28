/**
 * Formula commands of the ribbon: AutoSum, tracing the cells a formula reads
 * or that read it (drawn with the grid's decorations), and defined names.
 */
import type { CellDecoration, SheetGridController } from "../../grid";
import { MERGED_CELLS, coveredIn } from "../../grid/merge-guard";
import { type CellRange, type SheetId, type Workbook, formatA1Range } from "../../session/engine";
import type { SheetSession } from "../../session/session";
import type { EditResult } from "../../session/types";
import { goToNames, resolveGoTo } from "../name-box";

/** The decoration layer formula tracing owns. */
export const TRACE_LAYER = "formula-trace";
/** Most cells one trace marks; a reference to a whole column is cut to the used area first. */
export const MAX_TRACE_CELLS = 10_000;

export const AUTOSUM_FUNCTIONS = ["SUM", "AVERAGE", "COUNT", "MIN", "MAX"] as const;
export type AutoSumFunction = (typeof AUTOSUM_FUNCTIONS)[number];

export function isAutoSumFunction(value: string | null | undefined): value is AutoSumFunction {
  return (AUTOSUM_FUNCTIONS as readonly string[]).includes(value ?? "");
}

function isNumber(session: SheetSession, sheet: SheetId, row: number, col: number): boolean {
  return typeof session.raw(sheet, row, col).value === "number";
}

/** The run of numbers directly above (or else left of) a cell, or null. */
function adjacentNumbers(session: SheetSession, sheet: SheetId, row: number, col: number): CellRange | null {
  let top = row;
  while (top > 0 && isNumber(session, sheet, top - 1, col)) top--;
  if (top < row) return { start: { row: top, col }, end: { row: row - 1, col } };
  let left = col;
  while (left > 0 && isNumber(session, sheet, row, left - 1)) left--;
  if (left < col) return { start: { row, col: left }, end: { row, col: col - 1 } };
  return null;
}

export type AutoSumResult = EditResult | { ok: "editing" };

/**
 * One cell: puts `=SUM(...)` over the numbers above or to the left, or opens
 * the editor on `=SUM(` when there are none. A range: adds a total under
 * each column (or right of a single row), as one undo step.
 */
export function autoSum(controller: SheetGridController, fn: AutoSumFunction = "SUM"): AutoSumResult {
  const session = controller.session;
  const { sheet, active } = controller.getSelection();
  const range = controller.getActiveRange();
  const single = range.start.row === range.end.row && range.start.col === range.end.col;
  if (single) {
    const source = adjacentNumbers(session, sheet, active.row, active.col);
    if (source === null) {
      controller.startEdit(`=${fn}(`);
      return { ok: "editing" };
    }
    return session.setCellInput(sheet, active, `=${fn}(${formatA1Range(source)})`);
  }
  const edits = [];
  if (range.start.row === range.end.row) {
    const target = { row: range.start.row, col: range.end.col + 1 };
    edits.push({ sheet, ...target, input: `=${fn}(${formatA1Range(range)})` });
  } else {
    for (let col = range.start.col; col <= range.end.col; col++) {
      const column = { start: { row: range.start.row, col }, end: { row: range.end.row, col } };
      edits.push({ sheet, row: range.end.row + 1, col, input: `=${fn}(${formatA1Range(column)})` });
    }
  }
  // A total written under a merged cell would be stored but never shown.
  const covered = coveredIn(session.workbook.getSheet(sheet).mergedRanges, { start: { row: range.start.row, col: range.start.col }, end: { row: range.end.row + 1, col: range.end.col + 1 } });
  if (edits.some((edit) => covered(edit.row, edit.col))) return { ok: false, code: "not_allowed", message: MERGED_CELLS };
  return session.applyEdits(edits, "AutoSum");
}

/** Adds the cells of `range` that lie in the used area to `out`. False when `out` reached the limit before all of them were added. */
function cellsOf(session: SheetSession, sheet: SheetId, range: CellRange, kind: CellDecoration["kind"], out: CellDecoration[]): boolean {
  const used = session.sheet(sheet).dimensions;
  if (used === null) return true;
  const rowEnd = Math.min(range.end.row, used.end.row);
  const colEnd = Math.min(range.end.col, used.end.col);
  for (let row = range.start.row; row <= rowEnd; row++) {
    for (let col = range.start.col; col <= colEnd; col++) {
      if (out.length >= MAX_TRACE_CELLS) return false;
      out.push({ sheet, row, col, kind });
    }
  }
  return true;
}

/** `truncated` when more cells were found than are marked at once: only the first `count` are marked. */
export type TraceResult = { ok: true; count: number; truncated: boolean } | { ok: false; message: string };

/** Marks the cells the active cell's formula reads (`precedents`) or the formulas that read it (`dependents`). */
export function traceActiveCell(controller: SheetGridController, direction: "precedents" | "dependents"): TraceResult {
  const session = controller.session;
  const { sheet, active } = controller.getSelection();
  const marks: CellDecoration[] = [];
  let truncated = false;
  if (direction === "precedents") {
    for (const range of session.workbook.precedents(sheet, active)) {
      if (!cellsOf(session, range.sheet, range, "precedent", marks)) {
        truncated = true;
        break;
      }
    }
  } else {
    for (const cell of session.workbook.dependents(sheet, active)) {
      if (marks.length >= MAX_TRACE_CELLS) {
        truncated = true;
        break;
      }
      marks.push({ sheet: cell.sheet, row: cell.row, col: cell.col, kind: "dependent" });
    }
  }
  if (marks.length === 0) {
    controller.clearDecorations(TRACE_LAYER);
    return { ok: false, message: direction === "precedents" ? "The active cell has no formula that reads other cells." : "No formula reads the active cell." };
  }
  controller.decorate(TRACE_LAYER, marks);
  return { ok: true, count: marks.length, truncated };
}

/** Defined names a sheet can go to, for the names menu. */
export function namesFor(workbook: Pick<Workbook, "listDefinedNames">, sheet: SheetId): string[] {
  return goToNames(workbook, sheet).map((name) => name.name);
}

/** Selects the range a defined name stands for. */
export function goToName(controller: SheetGridController, name: string): { ok: true } | { ok: false; message: string } {
  const result = resolveGoTo(controller.session.workbook, controller.getSelection().sheet, name);
  if (!result.ok) return result;
  controller.select(result.range, result.sheet);
  return { ok: true };
}
