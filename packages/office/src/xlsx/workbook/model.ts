/**
 * The in-memory workbook: what the handle reads and edits.
 *
 * Cell content lives in {@link CellRec} records, each tied to the `<c>`
 * element it was read from. An edit changes the record and marks it; the XML
 * is brought up to date by `sheet-write.ts` when the part is needed (on
 * save, or when the change journal asks for it), and only for the rows that
 * changed. A sheet nobody edits is never written, so its part stays byte for
 * byte as it was, and its XML tree is not even kept in memory.
 */

import type { FormulaAst, FunctionRegistry } from "../../api/formula.js";
import type { OpcPackage, PartName } from "../../api/opc.js";
import type { CellRange, CellValue, FrozenPanes, SheetId, StyleId } from "../../api/xlsx.js";
import type { XmlDocument, XmlElement } from "../../api/xml.js";
import type { CellMutationListener, WorkbookJournal } from "./internals.js";
import type { SharedStrings } from "./shared-strings.js";
import type { SheetNotes } from "./notes.js";
import type { TablePart } from "./tables.js";
import type { StyleTable } from "./styles.js";

/** The cell's `<c>` element shows the current value and formula. */
export const CLEAN = 0;
/** Value or formula differ from the `<c>` element. */
export const DIRTY_CONTENT = 1;
/** The style differs from the `<c>` element. */
export const DIRTY_STYLE = 2;
/**
 * An edit replaced the content (not a calculation or a reference rewrite):
 * the cell and value metadata of the old `<c>` element (`cm`, `vm`) no
 * longer describe it.
 */
export const DIRTY_EDIT = 4;

/** What an array or data-table formula carries besides its text. */
export interface FormulaExtra {
  /** Attributes of the `<f>` element other than `ref`, in source order (`t`, `dt2D`, …). */
  attrs: ReadonlyArray<readonly [string, string]>;
  /** The range the formula fills. */
  ref: CellRange | null;
}

export interface CellRec {
  value: CellValue;
  /** Formula text without the leading `=`, or null. */
  formula: string | null;
  styleId: StyleId;
  /**
   * The element this cell was read from or last written to; null for a cell
   * not yet in the XML. While the sheet XML is not held in memory (see
   * {@link SheetModel.sourceText}) it is the position of the cell among the
   * `<c>` elements of its source row.
   */
  el: XmlElement | number | null;
  /** {@link CLEAN}, or a combination of {@link DIRTY_CONTENT}, {@link DIRTY_STYLE} and {@link DIRTY_EDIT}. */
  dirty: number;
  /** Shared formula group of the cell in the XML, or -1. */
  shared: number;
  /**
   * Set for an array or data-table formula. An array formula is calculated
   * and fills the range in `extra.ref`; a data table keeps its stored values.
   */
  extra: FormulaExtra | null;
}

export interface RowRec {
  index: number;
  el: XmlElement | null;
  cells: Map<number, CellRec>;
  /** Height in points, or null for the default. */
  height: number | null;
  hidden: boolean;
  /** A cell of the row, its position or its height changed since the element was written. */
  dirty: boolean;
  /** Attributes a row that is not in the XML yet takes when it is first written (a row format, an outline level). */
  attrs?: ReadonlyArray<readonly [string, string]>;
}

/** A run of columns that share width and visibility, as a `<col>` element stores them. */
export interface ColumnRun {
  /** First and last column, zero-based and inclusive. */
  min: number;
  max: number;
  /** Width in characters, or null when the run only carries other properties. */
  width: number | null;
  hidden: boolean;
  /** Attributes of the `<col>` element other than `min`, `max`, `width`, `customWidth` and `hidden`. */
  other: ReadonlyArray<readonly [string, string]>;
}

export interface SheetModel {
  id: SheetId;
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  partName: PartName;
  /** Relationship id from the workbook part to this sheet. */
  relId: string;
  /** The `<sheet>` element in the workbook part. */
  entry: XmlElement;
  /**
   * The parsed part, or null while only its text is held. A sheet is read
   * into cell records and its tree is then let go: a tree costs several
   * times the memory of the records, and a sheet that is never edited never
   * needs it. `attachSheet` parses the text again before the first write.
   */
  doc: XmlDocument | null;
  sheetData: XmlElement | null;
  /** Text of the part as opened, while {@link doc} is null. */
  sourceText: string | null;
  /** The rows of the part in document order, while {@link doc} is null, so each finds its element again. */
  sourceRows: RowRec[] | null;
  /** Rows by index. Iteration order is ascending unless {@link rowsUnordered} is set. */
  rows: Map<number, RowRec>;
  rowsUnordered: boolean;
  /** Rows were added, removed or moved: the children of `sheetData` must be rebuilt. */
  rowSetDirty: boolean;
  merges: CellRange[];
  mergesDirty: boolean;
  columns: ColumnRun[];
  columnsDirty: boolean;
  frozen: FrozenPanes;
  frozenDirty: boolean;
  defaultColumnWidth: number;
  defaultRowHeightPt: number;
  /** Some model state is newer than the XML. */
  dirty: boolean;
  /** The XML is newer than the part in the package. */
  partDirty: boolean;
  /** Shared formulas must be written out as ordinary ones at the next flush. */
  unshare: boolean;
  hasShared: boolean;
  /** The tables of the sheet, each a part of its own; see `./tables.ts`. At most `MAX_TABLES_PER_SHEET`. */
  tables: TablePart[];
  /** The comment parts of the sheet, or null when it has none; see `./notes.ts`. */
  notes: SheetNotes | null;
  /** Cells of the part that point into the shared string table, as of the last read or write of its XML. */
  stringRefs: number;
  /** Cached result of the dimension scan; undefined when out of date. */
  dimensions: CellRange | null | undefined;
}

export interface NameRec {
  name: string;
  refersTo: string;
  /** The sheet the name is local to, or null. */
  scope: SheetModel | null;
  /** The element in the workbook part; null for a name not yet written. */
  el: XmlElement | null;
}

/** The formula functions the workbook uses; the real module or a stand-in in tests. */
export interface FormulaDeps {
  parseFormula(text: string): FormulaAst;
  evaluate: import("../../api/formula.js").Evaluate;
  collectReferences: import("../../api/formula.js").CollectReferences;
  createFunctionRegistry: import("../../api/formula.js").CreateFunctionRegistry;
}

/** A sheet whose XML tree is in memory. */
export interface AttachedSheet extends SheetModel {
  doc: XmlDocument;
  sheetData: XmlElement;
}

/** A part the workbook holds as parsed XML. */
export interface PartEntry {
  name: PartName;
  doc: XmlDocument;
  /** The XML is newer than the part in the package. */
  dirty: boolean;
}

/** With more edited cells than this, everything is calculated instead of tracing what they reach. */
export const TRACE_LIMIT = 2000;

export interface CalcState {
  /**
   * Cells edited since the last calculation, per sheet, as `row * 16384 + col`. A sheet holds at most
   * {@link TRACE_LIMIT} + 1 of them: past that `all` is set and the marks are dropped.
   */
  edited: Map<SheetModel, Set<number>>;
  /** Everything must be calculated again (rows or columns moved, a sheet was removed). */
  all: boolean;
  /**
   * The first run calculates everything: the file came with formulas that
   * have no stored value, or asks for a full calculation on load. Unlike
   * {@link all} it does not by itself make `save` calculate, so a file that
   * is opened and saved untouched keeps its parts as they were.
   */
  onLoad: boolean;
  /**
   * Formula cells a bounded calculation did not reach, per sheet, as
   * `row * 16384 + col`. The next run starts with them. Bounded by the
   * formula cell count; emptied when `all` is set or a run completes.
   */
  pending: Map<SheetModel, Set<number>>;
  /** The dependency graph, or null when a formula or the structure changed since it was built. */
  graph: unknown;
  /** The `now` of the last explicit calculation, reused by the one `save` runs. */
  lastNow: string | null;
}

export interface WorkbookState {
  pkg: OpcPackage;
  workbookPart: PartEntry;
  sheets: SheetModel[];
  /** Sheets by id. One entry per sheet. */
  sheetsById: Map<SheetId, SheetModel>;
  /** Sheets by lower-case name. One entry per sheet. */
  sheetsByKey: Map<string, SheetModel>;
  strings: SharedStrings;
  stringsPartName: PartName | null;
  styles: StyleTable;
  stylesPart: PartEntry;
  /** False until a styles part exists in the package. */
  stylesInPackage: boolean;
  names: NameRec[];
  namesDirty: boolean;
  date1904: boolean;
  formula: FormulaDeps | null;
  functions: FunctionRegistry | null;
  calc: CalcState;
  /** At most 16 listeners. */
  listeners: CellMutationListener[];
  journal: WorkbookJournal | null;
  cellCount: number;
  maxCells: number;
  /** True once the calculation chain part was removed, or when there is none. */
  calcChainDropped: boolean;
  /** Parsed formulas by text; null for one that does not parse. Cleared when it reaches its cap. */
  parseCache: Map<string, FormulaAst | null>;
}

/** Key of a cell inside a sheet-wide set. */
export function cellKey(row: number, col: number): number {
  return row * 16384 + col;
}
