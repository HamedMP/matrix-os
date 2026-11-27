/**
 * What deleted rows or columns take from a sheet besides the content and
 * sizes of their cells, as plain data that can be kept and put back.
 *
 * Deleting rows shrinks or removes the ranges of conditional formats, data
 * validations, links, the auto filter and tables, drops notes, cuts array
 * formulas, loses the attributes of the rows and what the cells held besides
 * their content (rich text, cell metadata); inserting the rows again
 * does not bring any of that back. The change journal takes this state
 * before a proposed deletion and restores it when the deletion is rejected.
 * The state comes back from a saved file, so everything in it is checked
 * again before it is used.
 */

import type { CellRange } from "../../api/xlsx.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { cloneNode, escapeXmlAttr, getAttr, parseXml, remove, serializeXml, setAttr } from "../../xml/index.js";
import { formatA1Range, tryParseA1Range } from "./a1.js";
import { invalidateArrayRanges } from "./arrays.js";
import { applyCellMarkup, cellMarkup } from "./cell-markup.js";
import { ensureRow, findCell } from "./cells.js";
import { rewriteFeatureFormulasIn } from "./feature-formulas.js";
import { type ColumnRun, DIRTY_CONTENT, type SheetModel, type WorkbookState } from "./model.js";
import { noteTexts, restoreNoteTexts } from "./notes.js";
import { attachSheet } from "./sheet-read.js";
import { ROW_MODEL_ATTRS, WORKSHEET_ORDER } from "./sheet-write.js";
import { invalidateGraph } from "./state.js";
import { restoreTableRefs, tableRefs } from "./tables.js";
import { insertInOrder, localOf } from "./xml-util.js";

type AttrList = Array<[string, string]>;

/** JSON. Every field is plain data; see the module comment. */
export interface SheetFeatureState {
  /** Namespace declarations of the worksheet element, needed to read {@link elements} again. */
  ns: AttrList;
  /** Markup of the auto filter, conditional formats, data validations, links and extension list, in document order. */
  elements: string[];
  /** The `ref` attributes of each table part, in the order `tableRefs` lists them. */
  tables: Array<{ part: string; refs: Array<string | null> }>;
  /** The text of each note part. */
  notes: Array<{ name: string; text: string }>;
  /** Array and data-table formulas: their cell, the attributes of `<f>` and the range. */
  arrays: Array<{ row: number; col: number; attrs: AttrList; ref: string | null }>;
  /** Deleted rows that are hidden or carry attributes the model does not hold (a row format, an outline level). */
  rows: Array<{ index: number; hidden: boolean; attrs: AttrList }>;
  /** The column runs of the sheet before columns were deleted; null when rows were. */
  columns: Array<{ min: number; max: number; width: number | null; hidden: boolean; other: AttrList }> | null;
  /**
   * Deleted cells whose element holds more than value, formula and style
   * (rich text, cell metadata, extensions), as `<c>` markup; see `./cell-markup.ts`.
   * Absent in a state saved before cells were kept.
   */
  cells?: Array<{ row: number; col: number; markup: string }>;
}

/** The worksheet children that are kept as markup. */
const FEATURE_ELEMENTS: ReadonlySet<string> = new Set(["autoFilter", "conditionalFormatting", "dataValidations", "hyperlinks", "extLst"]);
/** Characters of markup and note text one state may hold; a proposed deletion on a sheet with more is refused. */
export const MAX_FEATURE_TEXT = 4 * 1024 * 1024;
/** Array formulas and rows one state may list. */
export const MAX_FEATURE_ITEMS = 100_000;

export function featureElements(root: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  for (const node of root.children) if (node.kind === "element" && FEATURE_ELEMENTS.has(localOf(node.name))) found.push(node);
  return found;
}

function tooMuch(): OfficeError {
  return new OfficeError("limit_exceeded", "the sheet has too much formatting to delete rows or columns in a proposal", {
    details: { maxFeatureText: MAX_FEATURE_TEXT, maxFeatureItems: MAX_FEATURE_ITEMS },
  });
}

/**
 * The state of a sheet that deleting `count` rows or columns from `index`
 * may change, or null when the sheet has nothing of the kind. Throws
 * `limit_exceeded` when it is too large to keep; nothing has changed then.
 */
export function captureSheetFeatures(
  state: WorkbookState,
  sheet: SheetModel,
  axis: "row" | "col",
  index: number,
  count: number,
): SheetFeatureState | null {
  const root = attachSheet(sheet).doc.root;
  const elements = featureElements(root).map((element) => serializeXml(element));
  const notes = noteTexts(sheet);
  let size = 0;
  for (const text of elements) size += text.length;
  for (const note of notes) size += note.text.length;
  if (size > MAX_FEATURE_TEXT) throw tooMuch();
  const arrays: SheetFeatureState["arrays"] = [];
  const rows: SheetFeatureState["rows"] = [];
  const cells: NonNullable<SheetFeatureState["cells"]> = [];
  const end = index + count;
  for (const row of sheet.rows.values()) {
    const rowInBand = axis === "row" && row.index >= index && row.index < end;
    for (const [col, cell] of row.cells) {
      if (rowInBand || (axis === "col" && col >= index && col < end)) {
        const markup = cellMarkup(state.strings, cell);
        if (markup !== null) {
          const text = serializeXml(markup);
          size += text.length;
          if (size > MAX_FEATURE_TEXT || cells.length >= MAX_FEATURE_ITEMS) throw tooMuch();
          cells.push({ row: row.index, col, markup: text });
        }
      }
      if (cell.extra === null) continue;
      if (arrays.length >= MAX_FEATURE_ITEMS) throw tooMuch();
      arrays.push({
        row: row.index,
        col,
        attrs: cell.extra.attrs.map(([name, value]) => [name, value]),
        ref: cell.extra.ref === null ? null : formatA1Range(cell.extra.ref),
      });
    }
    if (!rowInBand) continue;
    const attrs: AttrList = [];
    for (const attr of row.el?.attrs ?? []) if (!ROW_MODEL_ATTRS.has(attr.name)) attrs.push([attr.name, attr.value]);
    for (const [name, value] of row.attrs ?? []) attrs.push([name, value]);
    if (attrs.length > 0 || row.hidden) rows.push({ index: row.index, hidden: row.hidden, attrs });
  }
  const tables = tableRefs(sheet);
  const columns = axis === "col" ? sheet.columns.map((run) => ({ ...run, other: run.other.map(([name, value]): [string, string] => [name, value]) })) : null;
  const empty = elements.length === 0 && notes.length === 0 && arrays.length === 0 && rows.length === 0 && tables.length === 0 && cells.length === 0;
  if (empty && (columns === null || columns.length === 0)) return null;
  const ns: AttrList = [];
  for (const attr of root.attrs) if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) ns.push([attr.name, attr.value]);
  return { ns, elements, tables, notes, arrays, rows, columns, cells };
}

/** Reads the kept markup again, in the namespace context it was taken from. Elements of other kinds are left out. */
function parseElements(features: SheetFeatureState): XmlElement[] {
  if (features.elements.length === 0) return [];
  const declarations = features.ns.map(([name, value]) => ` ${name}="${escapeXmlAttr(value)}"`).join("");
  const wrapper = parseXml(`<worksheet${declarations}>${features.elements.join("")}</worksheet>`).root;
  return featureElements(wrapper);
}

/** The kept markup of each deleted cell, read again; markup that is not one `<c>` element gives null. */
function parseCells(features: SheetFeatureState): Array<XmlElement | null> {
  const cells = features.cells ?? [];
  if (cells.length === 0) return [];
  const declarations = features.ns.map(([name, value]) => ` ${name}="${escapeXmlAttr(value)}"`).join("");
  return cells.map((cell) => {
    const children = parseXml(`<worksheet${declarations}>${cell.markup}</worksheet>`).root.children;
    const only = children.length === 1 ? children[0] : undefined;
    return only !== undefined && only.kind === "element" && localOf(only.name) === "c" ? only : null;
  });
}

/** True when the markup of a state can be read; a state from a damaged file may not be. */
export function readableSheetFeatures(features: SheetFeatureState): boolean {
  try {
    parseElements(features);
    parseCells(features);
    for (const note of features.notes) parseXml(note.text);
    return true;
  } catch (error) {
    if (isOfficeError(error, "malformed_xml", "limit_exceeded")) return false;
    throw error;
  }
}

/**
 * Applies `rewrite` to the formulas inside the kept markup, as a rename or a
 * removed sheet does to the formulas of the workbook. A state that cannot be
 * read is returned as it is.
 */
export function rewriteSheetFeatures(features: SheetFeatureState, rewrite: (text: string) => string): SheetFeatureState {
  if (features.elements.length === 0 || !readableSheetFeatures(features)) return features;
  const declarations = features.ns.map(([name, value]) => ` ${name}="${escapeXmlAttr(value)}"`).join("");
  const wrapper = parseXml(`<worksheet${declarations}>${features.elements.join("")}</worksheet>`).root;
  if (!rewriteFeatureFormulasIn(wrapper, rewrite)) return features;
  return { ...features, elements: featureElements(wrapper).map((element) => serializeXml(element)) };
}

/**
 * Puts a sheet back into a state taken with {@link captureSheetFeatures},
 * after the deleted rows or columns were inserted again and their cells
 * restored. Call {@link readableSheetFeatures} first.
 */
export function restoreSheetFeatures(state: WorkbookState, sheet: SheetModel, features: SheetFeatureState): void {
  const root = attachSheet(sheet).doc.root;
  const elements = parseElements(features);
  for (const element of featureElements(root)) remove(element);
  for (const element of elements) insertInOrder(root, cloneNode(element), WORKSHEET_ORDER);
  restoreTableRefs(sheet, features.tables);
  restoreNoteTexts(sheet, features.notes);
  for (const saved of features.arrays) {
    const cell = findCell(sheet, saved.row, saved.col);
    const row = sheet.rows.get(saved.row);
    if (cell === undefined || row === undefined || cell.formula === null) continue;
    const ref: CellRange | null = saved.ref === null ? null : tryParseA1Range(saved.ref);
    cell.extra = { attrs: saved.attrs.map(([name, value]) => [name, value] as const), ref };
    cell.dirty |= DIRTY_CONTENT;
    row.dirty = true;
  }
  for (const saved of features.rows) {
    const row = ensureRow(sheet, saved.index);
    row.hidden = saved.hidden;
    row.dirty = true;
    // A row that is in the XML takes the attributes now; a new one takes them when it is first written.
    if (row.el !== null) {
      for (const [name, value] of saved.attrs) if (getAttr(row.el, name) !== value) setAttr(row.el, name, value);
    } else if (saved.attrs.length > 0) {
      row.attrs = saved.attrs.map(([name, value]) => [name, value] as const);
    }
  }
  const markups = parseCells(features);
  (features.cells ?? []).forEach((saved, at) => {
    const markup = markups[at] ?? null;
    const cell = findCell(sheet, saved.row, saved.col);
    const row = sheet.rows.get(saved.row);
    if (markup !== null && cell !== undefined && row !== undefined) applyCellMarkup(cell, row, cloneNode(markup));
  });
  if (features.columns !== null) {
    const runs: ColumnRun[] = features.columns.map((run) => ({ ...run, other: run.other.map(([name, value]) => [name, value] as const) }));
    sheet.columns = runs;
    sheet.columnsDirty = true;
  }
  invalidateArrayRanges(sheet);
  invalidateGraph(state);
  state.calc.all = true;
  sheet.dirty = true;
}
