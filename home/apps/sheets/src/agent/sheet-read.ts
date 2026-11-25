/** Reading cells for the deterministic checks and the trace, within a bound. Labels and lines are in `sheet-index.ts`. */

import { type Cell, type CellAddress, type SheetId, type Workbook, formatA1 } from "./engine";

/** The used part of one sheet, read once. `cells[r][c]` is the cell at `origin + (r, c)`. */
export interface SheetCells {
  sheet: SheetId;
  name: string;
  origin: CellAddress;
  rows: number;
  cols: number;
  cells: Cell[][];
}

/** Reads the used range of a sheet, or null when it is empty or larger than `maxCells`. */
export function readSheetCells(workbook: Workbook, sheet: SheetId, maxCells: number): SheetCells | null {
  const info = workbook.getSheet(sheet);
  const used = info.dimensions;
  if (used === null) return null;
  const rows = used.end.row - used.start.row + 1;
  const cols = used.end.col - used.start.col + 1;
  if (rows * cols > maxCells) return null;
  return { sheet, name: info.name, origin: used.start, rows, cols, cells: workbook.getRange(sheet, used) };
}

/** The cell at a sheet address, or null outside the used range. */
export function cellAt(data: SheetCells, row: number, col: number): Cell | null {
  const r = row - data.origin.row;
  const c = col - data.origin.col;
  if (r < 0 || c < 0 || r >= data.rows || c >= data.cols) return null;
  return data.cells[r]?.[c] ?? null;
}

export function isBlank(cell: Cell | null): boolean {
  return cell === null || (cell.value === null && cell.formula === null);
}

export function isText(cell: Cell | null): cell is Cell {
  return cell !== null && cell.formula === null && typeof cell.value === "string" && cell.value.trim() !== "";
}

export function isNumber(cell: Cell | null): cell is Cell & { value: number } {
  return cell !== null && typeof cell.value === "number";
}

/** True when a number format shows dates or times. */
export function isDateFormat(format: string): boolean {
  const bare = format.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}

/** `Sheet!A1`. */
export function locationOf(name: string, row: number, col: number): string {
  return `${name}!${formatA1({ row, col })}`;
}

/** A sheet name as a formula writes it: quoted when it is not a plain identifier. */
export function sheetRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}
