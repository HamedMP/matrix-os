/** How the formula engine reads the workbook during a calculation. */

import type { CellProvider, FormulaError, FormulaScalar, NameResolution, RangeBounds } from "../../api/formula.js";
import type { Dep } from "./calc-graph.js";
import { errorValue } from "./calc-values.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { lookupName } from "./names.js";
import { sheetDimensions } from "./sheet-write.js";
import { parseCached } from "./state.js";

/** Largest rectangle handed to a function in one piece. */
const MAX_RANGE_VALUES = 5_000_000;
/** Rectangles kept per formula that picks its cells at run time. */
export const MAX_READS = 64;

/**
 * What one evaluation read. While `reads` is a list, the provider adds every
 * rectangle it is asked for; past {@link MAX_READS} it sets `overflow` and
 * stops listing.
 */
export interface ReadLog {
  reads: Dep[] | null;
  overflow: boolean;
}

function note(log: ReadLog, sheet: SheetModel, r1: number, c1: number, r2: number, c2: number): void {
  const reads = log.reads;
  if (reads === null || log.overflow) return;
  const last = reads[reads.length - 1];
  if (last !== undefined && last.sheet === sheet && last.r1 === r1 && last.c1 === c1 && last.r2 === r2 && last.c2 === c2) return;
  if (reads.length >= MAX_READS) log.overflow = true;
  else reads.push({ sheet, r1, c1, r2, c2 });
}

export function makeProvider(state: WorkbookState, log: ReadLog): CellProvider {
  const sheetByName = (name: string): SheetModel | undefined => state.sheetsByKey.get(name.toLowerCase());
  return {
    getCellValue(sheetName, row, col): FormulaScalar {
      const sheet = sheetByName(sheetName);
      if (sheet === undefined) return errorValue("#REF!");
      if (log.reads !== null) note(log, sheet, row, col, row, col);
      return sheet.rows.get(row)?.cells.get(col)?.value ?? null;
    },
    getRangeValues(bounds: RangeBounds): FormulaScalar[][] | FormulaError {
      const sheet = sheetByName(bounds.sheet);
      if (sheet === undefined) return errorValue("#REF!");
      if (log.reads !== null) note(log, sheet, bounds.startRow, bounds.startCol, bounds.endRow, bounds.endCol);
      const used = sheetDimensions(sheet);
      if (used === null) return [];
      const lastRow = Math.min(bounds.endRow, used.end.row);
      const lastCol = Math.min(bounds.endCol, used.end.col);
      if (bounds.startRow > lastRow || bounds.startCol > lastCol) return [];
      const width = lastCol - bounds.startCol + 1;
      if ((lastRow - bounds.startRow + 1) * width > MAX_RANGE_VALUES) return errorValue("#VALUE!");
      const values: FormulaScalar[][] = [];
      for (let r = bounds.startRow; r <= lastRow; r++) {
        const line = new Array<FormulaScalar>(width).fill(null);
        const row = sheet.rows.get(r);
        if (row !== undefined) {
          if (row.cells.size < width) {
            for (const [col, cell] of row.cells) if (col >= bounds.startCol && col <= lastCol) line[col - bounds.startCol] = cell.value;
          } else {
            for (let c = 0; c < width; c++) line[c] = row.cells.get(bounds.startCol + c)?.value ?? null;
          }
        }
        values.push(line);
      }
      return values;
    },
    resolveName(name, sheetName): NameResolution | null {
      const record = lookupName(state, name, sheetByName(sheetName) ?? null);
      if (record === null) return null;
      const ast = parseCached(state, record.refersTo);
      return ast === null ? null : { kind: "formula", ast, sheet: record.scope?.name ?? sheetName };
    },
  };
}
