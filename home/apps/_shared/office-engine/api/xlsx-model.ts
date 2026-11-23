/**
 * Contract: the data model of a workbook. Used by the handle in `./xlsx.ts`;
 * implemented by `src/xlsx/`.
 *
 * Everything here is plain JSON-safe data.
 * Rows and columns are zero-based: `A1` is `{ row: 0, col: 0 }`.
 * Colours are `#rrggbb` in lower case; theme and indexed colours are resolved.
 */

import type { FormulaError } from "./formula.js";
import type { ZipLimits } from "./opc.js";

/**
 * Opaque id of a sheet. Stable for the life of the handle, across renames and
 * across save and reopen (derived from the sheet id stored in the workbook).
 */
export type SheetId = string;

/** Zero-based cell position. */
export interface CellAddress {
  row: number;
  col: number;
}

/** A rectangle, both corners inclusive, with `start` at the top left. */
export interface CellRange {
  start: CellAddress;
  end: CellAddress;
}

export interface SheetCellRef extends CellAddress {
  sheet: SheetId;
}

export interface SheetRangeRef extends CellRange {
  sheet: SheetId;
}

/** A cell value. `null` is empty. Dates are serial numbers with a date number format. */
export type CellValue = number | string | boolean | FormulaError | null;

/** Index of a cell format in the workbook's style table. 0 is the default format. */
export type StyleId = number;

export interface Cell {
  /** The literal value, or the last calculated result of the formula. */
  value: CellValue;
  /** Formula text without the leading `=`, or null for a literal. */
  formula: string | null;
  styleId: StyleId;
  /** The value formatted with the cell's number format, as shown in the grid. Empty for an empty cell. */
  display: string;
  /**
   * True when the formula uses syntax the engine does not evaluate. Such a
   * cell keeps the value stored in the file and is skipped by `recalc`.
   */
  formulaUnsupported: boolean;
  /**
   * The range of the array formula that fills this cell, or null. The
   * formula is in the first cell of the range; the other cells hold its
   * values. A cell of such a range cannot be edited on its own: an edit must
   * cover the whole range, which removes the formula.
   */
  arrayRange: CellRange | null;
  /** Id of the pending proposed change on this cell, or null. */
  pendingChangeId: string | null;
}

export interface FontStyle {
  name: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Null means automatic. */
  color: string | null;
}

export interface FillStyle {
  /** Solid background colour, or null for none. Pattern fills are reported as their foreground colour. */
  color: string | null;
}

export type BorderLineStyle = "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | "hair";

export interface BorderEdge {
  style: BorderLineStyle;
  color: string | null;
}

export interface BorderStyle {
  top: BorderEdge;
  right: BorderEdge;
  bottom: BorderEdge;
  left: BorderEdge;
}

export interface AlignmentStyle {
  /** `general` aligns text left and numbers right. */
  horizontal: "general" | "left" | "center" | "right" | "justify";
  vertical: "top" | "middle" | "bottom";
  wrapText: boolean;
  /** Indent level, 0 or more. */
  indent: number;
}

/** A complete cell format. */
export interface CellStyle {
  font: FontStyle;
  fill: FillStyle;
  border: BorderStyle;
  alignment: AlignmentStyle;
  /** Number format code, for example `General`, `0.00`, `#,##0`, `0%`, `yyyy-mm-dd`, `@`. */
  numberFormat: string;
}

/** The properties to change; everything left out keeps its value. */
export interface CellStylePatch {
  font?: Partial<FontStyle>;
  fill?: Partial<FillStyle>;
  border?: Partial<BorderStyle>;
  alignment?: Partial<AlignmentStyle>;
  numberFormat?: string;
}

export interface ColumnInfo {
  index: number;
  /** Width in characters of the default font, as spreadsheets store it. */
  width: number;
  hidden: boolean;
}

export interface RowInfo {
  index: number;
  heightPt: number;
  hidden: boolean;
}

export interface FrozenPanes {
  /** Number of rows frozen at the top; 0 for none. */
  rows: number;
  /** Number of columns frozen at the left; 0 for none. */
  cols: number;
}

export interface SheetInfo {
  id: SheetId;
  name: string;
  /** Position among the sheet tabs, from 0. */
  index: number;
  state: "visible" | "hidden" | "veryHidden";
  /** Smallest rectangle that holds every cell with a value, formula or non-default style. Null for an empty sheet. */
  dimensions: CellRange | null;
  defaultColumnWidth: number;
  defaultRowHeightPt: number;
  /** Columns with a width of their own or hidden, by index. */
  columns: ColumnInfo[];
  /** Rows with a height of their own or hidden, by index. */
  rows: RowInfo[];
  mergedRanges: CellRange[];
  frozen: FrozenPanes;
  /** Number of pending proposed changes on this sheet. */
  pendingChangeCount: number;
}

export interface DefinedName {
  name: string;
  /** Formula text without the leading `=`, for example `Sheet1!$A$1:$B$10`. */
  refersTo: string;
  /** The sheet the name is local to, or null for the whole workbook. */
  scope: SheetId | null;
}

/** A cell whose value changed in a recalculation. */
export interface ChangedCell extends SheetCellRef {
  previous: CellValue;
  value: CellValue;
}

export interface RecalcOptions {
  /** ISO 8601 time for NOW and TODAY, supplied by the caller. */
  now?: string;
  /** Maximum number of formula cells to evaluate. Default 200 000. */
  maxCells?: number;
  /** Maximum depth of a dependency chain. Default 10 000. */
  maxDepth?: number;
}

export interface RecalcResult {
  /** Cells whose value changed, in calculation order. */
  changed: ChangedCell[];
  /** Cells that are part of a circular reference. Their value is the error `#REF!`. */
  circular: SheetCellRef[];
  /** False when a bound in {@link RecalcOptions} stopped the run; the remaining cells keep their previous values. */
  complete: boolean;
}

export interface ProposalOptions {
  author: string;
  /** ISO 8601, supplied by the caller. */
  date: string;
  /** Short description of what the edits are for, shown in the review list. */
  label: string;
}

export interface Proposal extends ProposalOptions {
  id: string;
  /** Number of its changes that are still pending. */
  pendingCount: number;
}

/**
 * One proposed change to one cell. The cell already holds the new content;
 * accepting keeps it and rejecting restores the old content.
 */
export interface CellChange extends SheetCellRef {
  id: string;
  proposalId: string;
  author: string;
  date: string;
  label: string;
  oldValue: CellValue;
  newValue: CellValue;
  /** Formula text without the leading `=`, or null for a literal. */
  oldFormula: string | null;
  newFormula: string | null;
  oldStyleId: StyleId;
  newStyleId: StyleId;
}

export interface ResolveChangesResult {
  resolvedIds: string[];
  /** Cells whose content was restored by a rejection. Call `recalc` afterwards. */
  restored: SheetCellRef[];
  /**
   * Changes that were asked for but stay pending because the workbook no
   * longer holds their recorded new content (it was changed without the
   * journal seeing it), so a rejection cannot safely restore the old one.
   * Accepting such a change forgets it. Always empty for `acceptChanges`.
   */
  stale: string[];
}

export interface CsvParseOptions {
  /** Default: detected from the first lines among `,` `;` and tab. */
  delimiter?: string;
  /** Turn fields that look like numbers, TRUE or FALSE into typed values. Default true. A field starting with `=` is always text. */
  inferTypes?: boolean;
  /** Default `Sheet1`. */
  sheetName?: string;
  /** Maximum number of cells. Default 2 000 000; more throws `limit_exceeded`. */
  maxCells?: number;
}

export interface CsvWriteOptions {
  /** Default `,`. */
  delimiter?: string;
  /** Default `\r\n`. */
  lineEnding?: "\r\n" | "\n";
  /** Default: the dimensions of the sheet. */
  range?: CellRange;
  /** `raw` writes values (numbers unformatted, formulas as their result); `display` writes the formatted text. Default `raw`. */
  values?: "raw" | "display";
}

export interface OpenXlsxOptions {
  /** Overrides for the ZIP limits; see `ZipLimits`. */
  limits?: Partial<ZipLimits>;
  /** Maximum number of non-empty cells in the workbook. Default 2 000 000; more throws `limit_exceeded`. */
  maxCells?: number;
}
