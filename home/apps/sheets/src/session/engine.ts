/**
 * The one place where the Sheets app imports the document engine.
 *
 * Everything the session and the grid need from `_shared/office-engine` is
 * re-exported here, so a change of the engine's layout touches this file only.
 *
 * `getWorkbookInternals` is the engine's seam for code that must follow every
 * cell mutation (the change journal uses it too). The session uses it for
 * undo and redo: `onCellMutation` reports each changed cell with its content
 * before and after, including formulas the engine rewrites when rows or
 * columns move, and `writeRawCell` puts content back without recording it.
 */

export {
  MAX_COLS,
  MAX_ROWS,
  OfficeError,
  columnIndex,
  columnLabel,
  createFunctionRegistry,
  createXlsx,
  formatA1,
  formatA1Range,
  formatValue,
  formula,
  isOfficeError,
  openXlsx,
  parseA1,
  parseA1Range,
  parseCsv,
  parseSheetRange,
  toCsv,
  xlsx,
} from "../../../_shared/office-engine/index";

export type {
  BorderEdge,
  Cell,
  CellAddress,
  CellChange,
  CellRange,
  CellStyle,
  CellStylePatch,
  CellValue,
  ChangedCell,
  ColumnInfo,
  DefinedName,
  FormulaError,
  FrozenPanes,
  OfficeErrorCode,
  RecalcResult,
  ResolveChangesResult,
  RowInfo,
  SheetCellRef,
  SheetId,
  SheetInfo,
  SheetRangeRef,
  StyleId,
  Workbook,
} from "../../../_shared/office-engine/index";

export { getWorkbookInternals } from "../../../_shared/office-engine/xlsx/internal";
export { boolAttr, kid } from "../../../_shared/office-engine/xlsx/workbook/xml-util";
export { getAttr } from "../../../_shared/office-engine/xml/index";
export { scanCsv, sniffDelimiter } from "../../../_shared/office-engine/xlsx/csv/index";
export type { CellMutation, RawCell, WorkbookInternals } from "../../../_shared/office-engine/xlsx/internal";
