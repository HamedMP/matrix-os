/**
 * Toolbar commands that need more than one controller call: borders,
 * frozen panes presets and the style of the active cell.
 */
import type { GridSelection, SheetGridController } from "../grid";
import type { SheetSession } from "../session/session";
import type { BorderEdge, CellRange, CellStyle, SheetId } from "../session/engine";
import type { EditResult } from "../session/types";

export type BorderPreset = "all" | "outside" | "top" | "bottom" | "left" | "right" | "none";

export const BORDER_PRESETS: ReadonlyArray<{ id: BorderPreset; label: string }> = [
  { id: "all", label: "All borders" },
  { id: "outside", label: "Outside borders" },
  { id: "top", label: "Top border" },
  { id: "bottom", label: "Bottom border" },
  { id: "left", label: "Left border" },
  { id: "right", label: "Right border" },
  { id: "none", label: "No borders" },
];

export const FONT_FAMILIES = ["Calibri", "Arial", "Helvetica", "Verdana", "Georgia", "Times New Roman", "Courier New"] as const;
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48] as const;

export const TEXT_COLORS: ReadonlyArray<{ id: string; label: string; color: string | null }> = [
  { id: "auto", label: "Automatic", color: null },
  { id: "black", label: "Black", color: "#000000" },
  { id: "gray", label: "Gray", color: "#7f7f7f" },
  { id: "red", label: "Red", color: "#c00000" },
  { id: "orange", label: "Orange", color: "#e46c0a" },
  { id: "green", label: "Green", color: "#00804b" },
  { id: "blue", label: "Blue", color: "#1f5fbf" },
  { id: "purple", label: "Purple", color: "#7030a0" },
];

export const FILL_COLORS: ReadonlyArray<{ id: string; label: string; color: string | null }> = [
  { id: "none", label: "No fill", color: null },
  { id: "yellow", label: "Yellow", color: "#fff2a8" },
  { id: "green", label: "Green", color: "#d8f0dc" },
  { id: "blue", label: "Blue", color: "#dbe8fb" },
  { id: "red", label: "Red", color: "#fbdcdc" },
  { id: "orange", label: "Orange", color: "#fde6cf" },
  { id: "purple", label: "Purple", color: "#e9def6" },
  { id: "gray", label: "Gray", color: "#e7e7e7" },
];

const THIN: BorderEdge = { style: "thin", color: null };
const NONE: BorderEdge = { style: "none", color: null };

/** Applies a border preset to the active range as one undo step. */
export function applyBorders(controller: SheetGridController, preset: BorderPreset): EditResult {
  const session = controller.session;
  const sheet: SheetId = controller.getSelection().sheet;
  const range = controller.getActiveRange();
  const { start, end } = range;
  const row = (r: number): CellRange => ({ start: { row: r, col: start.col }, end: { row: r, col: end.col } });
  const col = (c: number): CellRange => ({ start: { row: start.row, col: c }, end: { row: end.row, col: c } });
  const rows = end.row - start.row + 1;
  const cols = end.col - start.col + 1;
  const cells = preset === "all" || preset === "none" ? rows * cols : preset === "outside" ? 2 * (rows + cols) : preset === "top" || preset === "bottom" ? cols : rows;
  return session.transact(BORDER_PRESETS.find((item) => item.id === preset)?.label ?? "Borders", (tx) => {
    // Counted before the first edge is drawn: a preset too large for one step changes nothing.
    tx.reserve(cells);
    const wb = tx.workbook;
    switch (preset) {
      case "all":
        wb.setStyle(sheet, range, { border: { top: THIN, right: THIN, bottom: THIN, left: THIN } });
        break;
      case "none":
        wb.setStyle(sheet, range, { border: { top: NONE, right: NONE, bottom: NONE, left: NONE } });
        break;
      case "outside":
        wb.setStyle(sheet, row(start.row), { border: { top: THIN } });
        wb.setStyle(sheet, row(end.row), { border: { bottom: THIN } });
        wb.setStyle(sheet, col(start.col), { border: { left: THIN } });
        wb.setStyle(sheet, col(end.col), { border: { right: THIN } });
        break;
      case "top":
        wb.setStyle(sheet, row(start.row), { border: { top: THIN } });
        break;
      case "bottom":
        wb.setStyle(sheet, row(end.row), { border: { bottom: THIN } });
        break;
      case "left":
        wb.setStyle(sheet, col(start.col), { border: { left: THIN } });
        break;
      case "right":
        wb.setStyle(sheet, col(end.col), { border: { right: THIN } });
        break;
    }
  });
}

/** Sorts the selection, or the block of data around the active cell, by the active column. */
export function sortRows(controller: SheetGridController, descending: boolean): void {
  controller.sort(descending);
}

export type FreezePreset = "selection" | "row" | "column" | "none";

export function applyFreeze(controller: SheetGridController, preset: FreezePreset): EditResult {
  const { sheet, active } = controller.getSelection();
  const frozen =
    preset === "selection" ? { rows: active.row, cols: active.col } : preset === "row" ? { rows: 1, cols: 0 } : preset === "column" ? { rows: 0, cols: 1 } : { rows: 0, cols: 0 };
  return controller.session.setFrozenPanes(sheet, frozen);
}

/** The style of the active cell, for the pressed state of the toolbar. */
export function activeStyle(session: SheetSession, selection: GridSelection): CellStyle {
  const { sheet, active } = selection;
  return session.workbook.getStyle(session.cell(sheet, active.row, active.col).styleId);
}
