/**
 * Cut and paste is a move: formulas anywhere in the workbook that read the
 * moved cells follow them, references inside the moved block move with it,
 * and references to cells the paste overwrote become `#REF!`.
 *
 * {@link planMove} reads every formula once, before anything changes, and
 * returns the new formula text of each cell that needs one. The caller
 * writes them in the same undo step as the move itself.
 */

import { type CellRange, type SheetId, type Workbook, formula as formulaEngine, getWorkbookInternals, isOfficeError } from "../session/engine";

/** Most cells read to find the formulas a move changes. */
export const MAX_MOVE_SCAN_CELLS = 2_000_000;

export interface MoveTarget {
  sheet: SheetId;
  row: number;
  col: number;
}

export interface FormulaRewrite {
  sheet: SheetId;
  row: number;
  col: number;
  formula: string;
}

export interface MovePlan {
  /** New formula text of each moved cell with a formula, by its position in the block (`r,c`). */
  moved: Map<string, string>;
  /** Formulas outside the block and outside the destination that change. */
  others: FormulaRewrite[];
}

function inside(range: CellRange, row: number, col: number): boolean {
  return row >= range.start.row && row <= range.end.row && col >= range.start.col && col <= range.end.col;
}

function rewrite(text: string, change: formulaEngine.ReferenceChange, home: string, homeAfter: string): string {
  try {
    return formulaEngine.rewriteFormulaText(text, change, home, homeAfter);
  } catch (error: unknown) {
    // A formula the engine cannot parse is left as it is.
    if (isOfficeError(error)) return text;
    throw error;
  }
}

/** The formula rewrites a move of `source` to `target` needs, or null when the workbook is too large to read. */
export function planMove(workbook: Workbook, sourceSheet: SheetId, source: CellRange, target: MoveTarget): MovePlan | null {
  const internals = getWorkbookInternals(workbook);
  const sheets = workbook.listSheets();
  const name = (id: SheetId): string => sheets.find((sheet) => sheet.id === id)?.name ?? "";
  const change: formulaEngine.ReferenceChange = {
    kind: "moveCells",
    from: { sheet: name(sourceSheet), startRow: source.start.row, startCol: source.start.col, endRow: source.end.row, endCol: source.end.col },
    toRow: target.row,
    toCol: target.col,
    toSheet: name(target.sheet),
  };
  const destination: CellRange = {
    start: { row: target.row, col: target.col },
    end: { row: target.row + source.end.row - source.start.row, col: target.col + source.end.col - source.start.col },
  };
  let scanned = 0;
  for (const sheet of sheets) {
    const used = sheet.dimensions;
    if (used !== null) scanned += (used.end.row - used.start.row + 1) * (used.end.col - used.start.col + 1);
  }
  if (scanned > MAX_MOVE_SCAN_CELLS) return null;
  const moved = new Map<string, string>();
  const others: FormulaRewrite[] = [];
  for (const sheet of sheets) {
    const used = sheet.dimensions;
    if (used === null) continue;
    const home = name(sheet.id);
    for (let row = used.start.row; row <= used.end.row; row++) {
      for (let col = used.start.col; col <= used.end.col; col++) {
        const text = internals.readRawCell(sheet.id, { row, col }).formula;
        if (text === null) continue;
        if (sheet.id === sourceSheet && inside(source, row, col)) {
          moved.set(`${row - source.start.row},${col - source.start.col}`, rewrite(text, change, home, name(target.sheet)));
          continue;
        }
        // The paste writes over the destination; what was there is gone.
        if (sheet.id === target.sheet && inside(destination, row, col)) continue;
        const next = rewrite(text, change, home, home);
        if (next !== text) others.push({ sheet: sheet.id, row, col, formula: next });
      }
    }
  }
  return { moved, others };
}
