/**
 * Contract: the workbook handle. Implemented by `src/xlsx/index.ts`.
 *
 * Type-only. The data model is in `./xlsx-model.ts` and is re-exported here.
 * Each function type is implemented as a value export with the camelCase name
 * given in {@link XlsxModule}.
 *
 * Rows and columns are zero-based. All methods except `save` are synchronous.
 * Parts of the file the engine does not model (charts, drawings, pivot
 * tables, macros) are kept byte for byte.
 *
 * Errors are `OfficeError`: `not_found` for an unknown sheet or name,
 * `invalid_argument` for an address outside the sheet or a bad name,
 * `invalid_operation` for an edit the state does not allow,
 * `stale_reference` for an unknown change id.
 */

import type { OpcPackage } from "./opc.js";
import type {
  Cell,
  CellAddress,
  CellChange,
  CellRange,
  CellStyle,
  CellStylePatch,
  CellValue,
  CsvParseOptions,
  CsvWriteOptions,
  DefinedName,
  FrozenPanes,
  OpenXlsxOptions,
  Proposal,
  ProposalOptions,
  RecalcOptions,
  RecalcResult,
  ResolveChangesResult,
  SheetCellRef,
  SheetId,
  SheetInfo,
  SheetRangeRef,
  StyleId,
} from "./xlsx-model.js";

export type * from "./xlsx-model.js";

/**
 * A workbook.
 *
 * Calculation: an edit marks the cells that depend on it as out of date but
 * does not calculate. `getCell` returns the last calculated value until
 * `recalc()` runs. `save()` runs `recalc()` first when anything is out of date.
 * An array formula sits in the first cell of its range and is calculated like
 * any other; the other cells of the range hold its values without a formula
 * and are filled again at every calculation (`Cell.arrayRange` names the
 * range on each of them). `setCell`, `setRange`, `setFormula`,
 * `setCellInput` and `clearRange` throw `invalid_operation` when they would
 * change part of such a range; an edit that covers the whole range removes
 * the array formula, and is refused inside a proposal. A data table, an
 * array formula over more than 100 000 cells and a formula with an unknown
 * function keep the values stored in the file (`Cell.formulaUnsupported`).
 *
 * Tables: the header cell of a table column is its name. Setting one renames
 * the column; a header that is not text, is empty, repeats another column of
 * the table or holds a formula, and clearing one, throw `invalid_operation`.
 *
 * Change journal: between `beginProposal` and `endProposal` every content or
 * style edit to a cell is also recorded as a {@link CellChange}. The cell
 * holds the new content at once, so dependants recalculate and the owner
 * sees the effect; the change stays pending until it is accepted or rejected.
 * - One pending change per cell: a second proposed edit to the same cell
 *   keeps the first old content and takes the latest new content. A change
 *   whose new content equals its old content is dropped.
 * - An edit outside a proposal to a cell with a pending change accepts that
 *   change first.
 * - While a sheet has pending changes, inserting or deleting its rows or
 *   columns and removing the sheet throw `invalid_operation`, inside a
 *   proposal too.
 * - Inside a proposal, inserting or deleting rows or columns of a sheet
 *   without pending changes, adding a sheet and renaming one are recorded
 *   as changes of their own kind; removing a sheet throws
 *   `invalid_operation`. Such a change is listed by `listChanges()` with
 *   null values (`row` or `col` is the first row or column); its kind,
 *   count and a one-line summary are on the `JournalChange` objects that
 *   `listJournalChanges(workbook)` of `src/xlsx/index.ts` returns. Rejecting
 *   a structural change or an added sheet also rejects every later change
 *   on that sheet.
 * - The journal is saved in the file as the part `/matrix/changeJournal.json`
 *   (content type `application/vnd.matrix-os.change-journal+json`, related
 *   from the workbook part with the type
 *   `https://matrix-os.com/schemas/office/2026/relationships/change-journal`)
 *   and is read back by `openXlsx`. On open, a change whose cell no longer
 *   holds the recorded new content is dropped.
 */
export interface Workbook {
  /** The underlying package. Edits made here bypass the model. */
  readonly package: OpcPackage;

  /** Sheets in tab order. */
  listSheets(): SheetInfo[];
  getSheet(sheet: SheetId): SheetInfo;
  /** Finds a sheet by name without regard to case, or null. */
  getSheetByName(name: string): SheetInfo | null;
  /**
   * Adds an empty sheet at the end, or at `index`. Names must be unique
   * without regard to case, 1 to 31 characters, without `: \ / ? * [ ]`.
   */
  addSheet(name: string, index?: number): SheetInfo;
  /** Renames a sheet and updates every formula and defined name that refers to it. */
  renameSheet(sheet: SheetId, name: string): void;
  /** Removes a sheet. References to it become `#REF!`. The last visible sheet cannot be removed. */
  removeSheet(sheet: SheetId): void;

  /** A cell; an empty one has value null, no formula and an empty display text. */
  getCell(sheet: SheetId, address: CellAddress): Cell;
  /** Cells of a rectangle, row by row. */
  getRange(sheet: SheetId, range: CellRange): Cell[][];
  getStyle(styleId: StyleId): CellStyle;

  /** Sets a literal value and removes any formula. A string is stored as text even when it starts with `=`. */
  setCell(sheet: SheetId, address: CellAddress, value: CellValue): void;
  /** Sets literal values from `start`, row by row. Rows may differ in length. */
  setRange(sheet: SheetId, start: CellAddress, values: ReadonlyArray<ReadonlyArray<CellValue>>): void;
  /**
   * Sets a formula (with or without the leading `=`), or removes it with
   * null, which keeps the last value as a literal. A formula that does not
   * parse throws `formula_error` and the cell is unchanged.
   */
  setFormula(sheet: SheetId, address: CellAddress, formula: string | null): void;
  /**
   * Sets a cell from text as a person types it: a leading `=` is a formula,
   * a number, percentage, date (`yyyy-mm-dd`), TRUE or FALSE becomes a typed
   * value (a date also gets a date format when the cell has the general
   * format), a leading `'` forces text, an empty string clears the cell.
   */
  setCellInput(sheet: SheetId, address: CellAddress, input: string): void;
  /** Clears values and formulas (`contents`), formats (`formats`) or both (`all`). Default `contents`. */
  clearRange(sheet: SheetId, range: CellRange, what?: "contents" | "formats" | "all"): void;
  /** Applies a style patch to every cell of the range and returns nothing; equal styles share one id. */
  setStyle(sheet: SheetId, range: CellRange, patch: CellStylePatch): void;

  /**
   * Structural edits. Cells, merged ranges, sizes, formulas, defined names
   * and the ranges of conditional formats, validations, links and tables
   * move with their rows and columns; a reference to a deleted cell becomes
   * `#REF!`. `index` is the first row or column inserted or deleted.
   *
   * A table (a list object with a header row) cannot be cut apart: inserting
   * or deleting a column inside one, and deleting its header row, its totals
   * row or all of its data rows, throw `invalid_operation`. Rows inserted or
   * deleted among its data make it grow or shrink.
   */
  insertRows(sheet: SheetId, index: number, count: number): void;
  deleteRows(sheet: SheetId, index: number, count: number): void;
  insertColumns(sheet: SheetId, index: number, count: number): void;
  deleteColumns(sheet: SheetId, index: number, count: number): void;

  /** Width in characters, or null for the default width. */
  setColumnWidth(sheet: SheetId, col: number, width: number | null): void;
  /** Height in points, or null for the default height. */
  setRowHeight(sheet: SheetId, row: number, heightPt: number | null): void;
  /** Merges a range; one that overlaps an existing merge throws `invalid_operation`. The top-left cell keeps its content. */
  mergeCells(sheet: SheetId, range: CellRange): void;
  /** Removes every merge that intersects the range. */
  unmergeCells(sheet: SheetId, range: CellRange): void;
  setFrozenPanes(sheet: SheetId, frozen: FrozenPanes): void;

  listDefinedNames(): DefinedName[];
  /** Adds a name, or replaces the one with the same name and scope. */
  setDefinedName(name: DefinedName): void;
  /** Returns false when there was no such name. */
  removeDefinedName(name: string, scope?: SheetId | null): boolean;

  /** Calculates every out-of-date formula cell in dependency order. */
  recalc(options?: RecalcOptions): RecalcResult;
  /** The cells and ranges the formula of a cell reads directly. Empty for a literal. */
  precedents(sheet: SheetId, address: CellAddress): SheetRangeRef[];
  /** The formula cells that read a cell directly. */
  dependents(sheet: SheetId, address: CellAddress): SheetCellRef[];

  /** Starts recording edits as proposed changes. Throws `invalid_operation` when a proposal is already open. Returns the proposal id. */
  beginProposal(options: ProposalOptions): string;
  /** Stops recording. Later edits apply directly. A no-op when no proposal is open. */
  endProposal(): void;
  /** Proposals that still have pending changes, oldest first. */
  listProposals(): Proposal[];
  /** Pending changes by sheet, row and column. */
  listChanges(): CellChange[];
  /** Keeps the new content and removes the changes from the journal. An unknown id throws `stale_reference`. */
  acceptChanges(ids: readonly string[] | "all"): ResolveChangesResult;
  /**
   * Restores the old value, formula and style and removes the changes from
   * the journal. A change that went stale is left pending and named in
   * `ResolveChangesResult.stale`.
   */
  rejectChanges(ids: readonly string[] | "all"): ResolveChangesResult;

  /** Serialises the workbook, with its change journal. The handle stays usable. */
  save(): Promise<Uint8Array>;
}

/**
 * Opens an `.xlsx`. Throws the errors of `openPackage`, `unsupported_format`
 * when the package is not a spreadsheet or holds a chart or macro sheet,
 * `corrupt_package` or `malformed_xml` for a missing or broken required
 * part, and `limit_exceeded` for too many cells. A change journal that
 * cannot be read is ignored and reported by `getJournalWarnings(workbook)`.
 */
export type OpenXlsx = (bytes: Uint8Array, options?: OpenXlsxOptions) => Promise<Workbook>;

/** Creates a workbook with the given sheets, or one sheet named `Sheet1`. */
export type CreateXlsx = (options?: { sheetNames?: string[] }) => Workbook;

/**
 * Parses delimiter-separated text (RFC 4180 quoting, any line ending, an
 * optional byte-order mark) into a workbook with one sheet.
 */
export type ParseCsv = (text: string, options?: CsvParseOptions) => Workbook;

/**
 * Writes one sheet as delimiter-separated text. A field is quoted when it
 * holds the delimiter, a quote or a line break. Trailing empty cells of a row
 * are written; error values are written as their code.
 */
export type ToCsv = (workbook: Workbook, sheet: SheetId, options?: CsvWriteOptions) => string;

/** Formats a value with a number format code, as `Cell.display` does. */
export type FormatValue = (value: CellValue, formatCode: string, options?: { date1904?: boolean }) => string;

/** `0` gives `A`, `26` gives `AA`. */
export type ColumnLabel = (col: number) => string;
/** `A` gives `0`; case-insensitive. Throws `invalid_argument` for anything that is not a column label. */
export type ColumnIndex = (label: string) => number;
/** `B3` or `$B$3` gives `{ row: 2, col: 1 }`. Throws `invalid_argument`. */
export type ParseA1 = (text: string) => CellAddress;
/** `{ row: 2, col: 1 }` gives `B3`. */
export type FormatA1 = (address: CellAddress) => string;
/**
 * `A1:C3`, a single cell `B2`, whole columns `A:C` or whole rows `2:5`.
 * Corners are normalised so that `start` is the top left. Throws `invalid_argument`.
 */
export type ParseA1Range = (text: string) => CellRange;
/** Writes `A1:C3`, or `B2` for a single cell. */
export type FormatA1Range = (range: CellRange) => string;
/** Splits `Sheet1!A1:B2` or `'My sheet'!A1`; `sheetName` is null without a sheet part. */
export type ParseSheetRange = (text: string) => { sheetName: string | null; range: CellRange };

/** The value exports of `src/xlsx/index.ts`. */
export interface XlsxModule {
  openXlsx: OpenXlsx;
  createXlsx: CreateXlsx;
  parseCsv: ParseCsv;
  toCsv: ToCsv;
  formatValue: FormatValue;
  columnLabel: ColumnLabel;
  columnIndex: ColumnIndex;
  parseA1: ParseA1;
  formatA1: FormatA1;
  parseA1Range: ParseA1Range;
  formatA1Range: FormatA1Range;
  parseSheetRange: ParseSheetRange;
  /** Rows in a sheet. */
  MAX_ROWS: 1048576;
  /** Columns in a sheet. */
  MAX_COLS: 16384;
}
