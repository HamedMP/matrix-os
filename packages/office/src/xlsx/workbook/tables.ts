/**
 * Tables (list objects) of a worksheet.
 *
 * A table lives in a part of its own that names its range and its columns.
 * Spreadsheet software refuses a workbook whose table no longer matches its
 * cells: a range that does not sit on the header row, or a column name that
 * differs from the text of its header cell. So the range of a table moves
 * with inserted and deleted rows and columns, an edit that would cut a table
 * apart is refused, and a header cell and its column name change together.
 *
 * What is not done: inserting or deleting a column inside a table, and
 * deleting its header row, its totals row or all of its data rows, throw
 * `invalid_operation`.
 */

import type { OpcPackage, PartName } from "../../api/opc.js";
import type { CellRange, CellValue } from "../../api/xlsx.js";
import type { XmlDocument, XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { getAttr, parseXml, serializeXml, setAttr } from "../../xml/index.js";
import { formatA1Range, tryParseA1Range } from "./a1.js";
import type { SheetModel } from "./model.js";
import { type StructuralOp, moveSpan } from "./refs-rewrite.js";
import { isNamed, kid, kids } from "./xml-util.js";

/** A table part held as parsed XML. */
export interface TablePart {
  name: PartName;
  doc: XmlDocument;
  /** The XML is newer than the part in the package. */
  dirty: boolean;
}

/** At most this many tables of one sheet are read; a sheet with more keeps them untouched and refuses structural edits. */
export const MAX_TABLES_PER_SHEET = 512;

/** The parts a worksheet relates to as tables. */
export function tablePartNames(pkg: OpcPackage, sheetPart: PartName): PartName[] {
  const names: PartName[] = [];
  for (const relationship of pkg.getRelationships(sheetPart)) {
    if (relationship.targetMode !== "Internal" || !relationship.type.endsWith("/table")) continue;
    const part = pkg.resolveTarget(sheetPart, relationship.target);
    if (pkg.hasPart(part) && names.length < MAX_TABLES_PER_SHEET) names.push(part);
  }
  return names;
}

/** Parses the table parts of a sheet from the texts read at open. A part that is not a table is left alone. */
export function readTables(names: readonly PartName[], textOf: (name: PartName) => string | undefined): TablePart[] {
  const tables: TablePart[] = [];
  for (const name of names) {
    const text = textOf(name);
    if (text === undefined) continue;
    const doc = parseXml(text);
    if (isNamed(doc.root.name, "table")) tables.push({ name, doc, dirty: false });
  }
  return tables;
}

interface TableShape {
  part: TablePart;
  ref: CellRange;
  headerRows: number;
  totalsRows: number;
}

function countAttr(root: XmlElement, name: string, fallback: number): number {
  const value = Number(getAttr(root, name) ?? String(fallback));
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function shapes(sheet: SheetModel): TableShape[] {
  const out: TableShape[] = [];
  for (const part of sheet.tables) {
    const root = part.doc.root;
    const ref = tryParseA1Range(getAttr(root, "ref") ?? "");
    if (ref === null) continue;
    out.push({ part, ref, headerRows: countAttr(root, "headerRowCount", 1), totalsRows: countAttr(root, "totalsRowCount", 0) });
  }
  return out;
}

function refuse(message: string): OfficeError {
  return new OfficeError("invalid_operation", message);
}

/** Throws when inserting or deleting rows or columns would cut a table of the sheet apart. Changes nothing. */
export function checkTablesForStructure(sheet: SheetModel, op: StructuralOp): void {
  for (const { ref, headerRows, totalsRows } of shapes(sheet)) {
    const rows = op.axis === "row";
    const low = rows ? ref.start.row : ref.start.col;
    const high = rows ? ref.end.row : ref.end.col;
    if (op.count > 0) {
      // Before the table it moves as a whole; after it nothing happens.
      if (op.index <= low || op.index > high) continue;
      if (!rows) throw refuse("a column cannot be inserted inside a table");
      if (op.index < low + headerRows) throw refuse("rows cannot be inserted inside the header of a table");
      continue;
    }
    const first = op.index;
    const last = op.index - op.count - 1;
    if (last < low || first > high) continue;
    if (!rows) throw refuse("the columns of a table cannot be deleted");
    const dataLow = low + headerRows;
    const dataHigh = high - totalsRows;
    if (first < dataLow || last > dataHigh) throw refuse("the header and the totals row of a table cannot be deleted");
    if (dataHigh - dataLow + 1 + op.count < 1) throw refuse("a table must keep one row of data");
  }
}

function moveRef(element: XmlElement, op: StructuralOp): boolean {
  const range = tryParseA1Range(getAttr(element, "ref") ?? "");
  if (range === null) return false;
  const span = op.axis === "row" ? moveSpan(range.start.row, range.end.row, op) : moveSpan(range.start.col, range.end.col, op);
  if (span === null) return false;
  const moved: CellRange =
    op.axis === "row"
      ? { start: { row: span.low, col: range.start.col }, end: { row: span.high, col: range.end.col } }
      : { start: { row: range.start.row, col: span.low }, end: { row: range.end.row, col: span.high } };
  const text = formatA1Range(moved);
  if (text === getAttr(element, "ref")) return false;
  setAttr(element, "ref", text);
  return true;
}

/** The elements of a table part that carry a `ref`: the table, its filter, their sort states and conditions. */
function refElements(root: XmlElement): XmlElement[] {
  const found: XmlElement[] = [root];
  const filter = kid(root, "autoFilter");
  for (const element of [filter, kid(root, "sortState"), filter === null ? null : kid(filter, "sortState")]) {
    if (element === null) continue;
    found.push(element, ...kids(element, "sortCondition"));
  }
  return found;
}

/** Moves the ranges of the tables of a sheet with its rows and columns. Call after {@link checkTablesForStructure}. */
export function moveTables(sheet: SheetModel, op: StructuralOp): void {
  for (const part of sheet.tables) {
    let changed = false;
    for (const element of refElements(part.doc.root)) if (moveRef(element, op)) changed = true;
    if (changed) part.dirty = true;
  }
}

/** The `ref` attributes of every table of the sheet, for a snapshot. */
export function tableRefs(sheet: SheetModel): Array<{ part: string; refs: Array<string | null> }> {
  return sheet.tables.map((part) => ({ part: part.name, refs: refElements(part.doc.root).map((element) => getAttr(element, "ref")) }));
}

/** Puts back ranges taken with {@link tableRefs}. A table whose elements no longer match is left alone. */
export function restoreTableRefs(sheet: SheetModel, saved: ReadonlyArray<{ part: string; refs: ReadonlyArray<string | null> }>): void {
  for (const part of sheet.tables) {
    const entry = saved.find((item) => item.part === part.name);
    const elements = refElements(part.doc.root);
    if (entry === undefined || entry.refs.length !== elements.length) continue;
    elements.forEach((element, at) => {
      const ref = entry.refs[at];
      if (ref === null || ref === undefined || tryParseA1Range(ref) === null || getAttr(element, "ref") === ref) return;
      setAttr(element, "ref", ref);
      part.dirty = true;
    });
  }
}

/** The table and column a cell is the header of, or null. */
function headerAt(sheet: SheetModel, row: number, col: number): { part: TablePart; columns: XmlElement[]; index: number } | null {
  for (const { part, ref, headerRows } of shapes(sheet)) {
    if (headerRows === 0 || row !== ref.start.row + headerRows - 1 || col < ref.start.col || col > ref.end.col) continue;
    const list = kid(part.doc.root, "tableColumns");
    const columns = list === null ? [] : kids(list, "tableColumn");
    const index = col - ref.start.col;
    if (columns[index] === undefined) return null;
    return { part, columns, index };
  }
  return null;
}

export interface CellWrite {
  row: number;
  col: number;
  value: CellValue;
  formula: string | null;
}

/**
 * Throws when one of the writes would leave a table header that
 * spreadsheet software refuses: a header is text, not empty, without line
 * breaks, and no two columns of a table share a name. Changes nothing, so a
 * call that writes several cells stays all or nothing.
 */
export function checkTableHeaderWrites(sheet: SheetModel, writes: Iterable<CellWrite>): void {
  if (sheet.tables.length === 0) return;
  /** Column names as they will be, per table. Local to this call: at most one entry per table of the sheet. */
  const names = new Map<TablePart, string[]>();
  for (const write of writes) {
    const header = headerAt(sheet, write.row, write.col);
    if (header === null) continue;
    if (write.formula !== null) throw refuse("the header of a table cannot hold a formula");
    const value = write.value;
    if (typeof value !== "string" || value === "") throw refuse("the header of a table must be text");
    if (/[\u0000-\u001f]/.test(value) || value.length > 255) throw refuse("the header of a table is one line of at most 255 characters");
    let list = names.get(header.part);
    if (list === undefined) {
      list = header.columns.map((column) => (getAttr(column, "name") ?? "").toLowerCase());
      names.set(header.part, list);
    }
    const key = value.toLowerCase();
    if (list.some((name, at) => at !== header.index && name === key)) throw refuse("the table already has a column with that name");
    list[header.index] = key;
  }
}

/** True when the range holds a header cell of a table. */
export function holdsTableHeader(sheet: SheetModel, range: CellRange): boolean {
  for (const { ref, headerRows } of shapes(sheet)) {
    if (headerRows === 0) continue;
    const row = ref.start.row + headerRows - 1;
    if (row >= range.start.row && row <= range.end.row && ref.start.col <= range.end.col && ref.end.col >= range.start.col) return true;
  }
  return false;
}

/** Gives the column of a table the name its header cell now holds. */
export function renameTableColumn(sheet: SheetModel, row: number, col: number, value: CellValue): void {
  if (sheet.tables.length === 0 || typeof value !== "string" || value === "") return;
  const header = headerAt(sheet, row, col);
  if (header === null) return;
  const column = header.columns[header.index] as XmlElement;
  if (getAttr(column, "name") === value) return;
  setAttr(column, "name", value);
  header.part.dirty = true;
}

/** Writes the table parts that changed back into the package. */
export function flushTables(pkg: OpcPackage, sheets: readonly SheetModel[]): void {
  for (const sheet of sheets) {
    for (const part of sheet.tables) {
      if (!part.dirty) continue;
      pkg.setPart(part.name, serializeXml(part.doc));
      part.dirty = false;
    }
  }
}
