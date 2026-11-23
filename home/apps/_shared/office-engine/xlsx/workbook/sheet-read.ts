/** Reads a worksheet part into a {@link SheetModel}. */

import type { FormulaErrorCode } from "../../api/formula.js";
import type { CellRange, CellValue, FrozenPanes } from "../../api/xlsx.js";
import type { XmlChildNode, XmlDocument, XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { getAttr, parseXml, textContent } from "../../xml/index.js";
import { isoToSerial } from "../format/serial.js";
import { MAX_COLS, MAX_ROWS, tryParseA1Range } from "./a1.js";
import {
  type AttachedSheet,
  CLEAN,
  type CellRec,
  type ColumnRun,
  type FormulaExtra,
  type RowRec,
  type SheetModel,
} from "./model.js";
import { shiftRelativeRefs } from "./refs-rewrite.js";
import { type SharedStrings, stringItemText } from "./shared-strings.js";
import { boolAttr, decodeCellText, isNamed, kid, kids } from "./xml-util.js";

const ERROR_CODES: ReadonlySet<string> = new Set(["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#NULL!"]);

/** Excel's default column width in characters, used when the sheet states none. */
export const DEFAULT_COLUMN_WIDTH = 8.43;
export const DEFAULT_ROW_HEIGHT = 15;

export interface ReadContext {
  strings: SharedStrings;
  date1904: boolean;
  /** Running count of non-empty cells across the workbook. */
  cellCount: number;
  maxCells: number;
  /** Set when a formula cell comes without a stored value. */
  uncalculated?: boolean;
}

function corrupt(message: string): OfficeError {
  return new OfficeError("corrupt_package", message);
}

/** Column of an A1 reference, reading only its letters; -1 when there are none. */
function columnOfRef(ref: string): number {
  let col = 0;
  let i = 0;
  if (ref.charCodeAt(0) === 36) i++;
  for (; i < ref.length; i++) {
    const code = ref.charCodeAt(i) & ~32;
    if (code < 65 || code > 90) break;
    col = col * 26 + (code - 64);
  }
  return col === 0 || col > MAX_COLS ? -1 : col - 1;
}

function readValue(type: string | null, raw: string | null, inline: XmlElement | null, context: ReadContext): CellValue {
  switch (type) {
    case null:
    case "n": {
      if (raw === null || raw === "") return null;
      const value = Number(raw);
      if (Number.isNaN(value)) throw corrupt("a numeric cell holds text");
      return value;
    }
    case "s": {
      if (raw === null || raw === "") return null;
      const text = context.strings.get(Number(raw));
      if (text === null) throw corrupt("a cell points outside the shared string table");
      return text;
    }
    case "str":
      return raw === null ? null : decodeCellText(raw);
    case "inlineStr":
      return inline !== null ? stringItemText(inline) : raw === null ? null : decodeCellText(raw);
    case "b":
      return raw === null ? null : raw === "1" || raw === "true";
    case "e": {
      if (raw === null) return null;
      const code = ERROR_CODES.has(raw) ? (raw as FormulaErrorCode) : raw === "#GETTING_DATA" ? "#N/A" : "#VALUE!";
      return { kind: "error", code };
    }
    case "d":
      return raw === null ? null : (isoToSerial(raw, context.date1904) ?? raw);
    default:
      return raw === null ? null : decodeCellText(raw);
  }
}

interface SharedMaster {
  row: number;
  col: number;
  text: string;
}

function readCell(
  element: XmlElement,
  row: number,
  col: number,
  context: ReadContext,
  masters: Map<number, SharedMaster>,
  sheetFlags: { hasShared: boolean },
): CellRec {
  let raw: string | null = null;
  let formulaElement: XmlElement | null = null;
  let inline: XmlElement | null = null;
  const nodes = element.children;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as XmlChildNode;
    if (node.kind !== "element") continue;
    if (isNamed(node.name, "v")) raw = textContent(node);
    else if (isNamed(node.name, "f")) formulaElement = node;
    else if (isNamed(node.name, "is")) inline = node;
  }
  const style = getAttr(element, "s");
  const styleId = style === null ? 0 : Number(style);
  const cell: CellRec = {
    value: readValue(getAttr(element, "t"), raw, inline, context),
    formula: null,
    styleId: Number.isInteger(styleId) && styleId > 0 ? styleId : 0,
    el: element,
    dirty: CLEAN,
    shared: -1,
    extra: null,
  };
  if (formulaElement !== null) {
    const kind = getAttr(formulaElement, "t");
    const text = textContent(formulaElement);
    if (kind === "shared") {
      const group = Number(getAttr(formulaElement, "si") ?? "-1");
      if (Number.isInteger(group) && group >= 0) {
        sheetFlags.hasShared = true;
        cell.shared = group;
        if (text !== "") {
          masters.set(group, { row, col, text });
          cell.formula = text;
        } else {
          const master = masters.get(group);
          if (master !== undefined) cell.formula = shiftRelativeRefs(master.text, row - master.row, col - master.col);
        }
      } else if (text !== "") {
        cell.formula = text;
      }
    } else if (kind === "array" || kind === "dataTable") {
      const attrs: Array<readonly [string, string]> = [];
      let ref: CellRange | null = null;
      for (const attr of formulaElement.attrs) {
        if (attr.name === "ref") ref = tryParseA1Range(attr.value);
        else attrs.push([attr.name, attr.value]);
      }
      const extra: FormulaExtra = { attrs, ref };
      cell.extra = extra;
      cell.formula = text;
    } else if (text !== "") {
      cell.formula = text;
    }
  }
  if (cell.formula !== null && cell.value === null) context.uncalculated = true;
  if (cell.value !== null || cell.formula !== null) {
    if (++context.cellCount > context.maxCells) {
      throw new OfficeError("limit_exceeded", "the workbook has more cells than the limit allows", {
        details: { maxCells: context.maxCells },
      });
    }
  }
  return cell;
}

interface ReadRows extends Pick<SheetModel, "rows" | "rowsUnordered" | "hasShared" | "stringRefs"> {
  /** Rows in document order. */
  ordered: RowRec[];
}

function readRows(sheetData: XmlElement, context: ReadContext): ReadRows {
  const rows = new Map<number, RowRec>();
  // Shared formula masters by group. One entry per group of this sheet.
  const masters = new Map<number, SharedMaster>();
  const flags = { hasShared: false };
  let stringRefs = 0;
  const ordered: RowRec[] = [];
  let rowsUnordered = false;
  let nextRow = 0;
  let lastRow = -1;
  const rowNodes = sheetData.children;
  for (let r = 0; r < rowNodes.length; r++) {
    const rowElement = rowNodes[r] as XmlChildNode;
    if (rowElement.kind !== "element" || !isNamed(rowElement.name, "row")) continue;
    const rowAttr = getAttr(rowElement, "r");
    const index = rowAttr === null ? nextRow : Number(rowAttr) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ROWS) throw corrupt("a row number is outside the sheet");
    if (rows.has(index)) throw corrupt("a row appears twice");
    if (index < lastRow) rowsUnordered = true;
    lastRow = Math.max(lastRow, index);
    nextRow = index + 1;
    const height = getAttr(rowElement, "ht");
    const heightPt = height === null ? Number.NaN : Number(height);
    const row: RowRec = {
      index,
      el: rowElement,
      cells: new Map(),
      height: Number.isFinite(heightPt) && heightPt >= 0 ? heightPt : null,
      hidden: boolAttr(getAttr(rowElement, "hidden"), false),
      dirty: false,
    };
    let nextCol = 0;
    const cellNodes = rowElement.children;
    for (let c = 0; c < cellNodes.length; c++) {
      const cellElement = cellNodes[c] as XmlChildNode;
      if (cellElement.kind !== "element" || !isNamed(cellElement.name, "c")) continue;
      const ref = getAttr(cellElement, "r");
      const col = ref === null ? nextCol : columnOfRef(ref);
      if (col < 0 || col >= MAX_COLS) throw corrupt("a cell reference is outside the sheet");
      if (row.cells.has(col)) throw corrupt("a cell appears twice");
      nextCol = col + 1;
      if (getAttr(cellElement, "t") === "s") stringRefs++;
      row.cells.set(col, readCell(cellElement, index, col, context, masters, flags));
    }
    rows.set(index, row);
    ordered.push(row);
  }
  return { rows, rowsUnordered, hasShared: flags.hasShared, ordered, stringRefs };
}

const COLUMN_OWN_ATTRS: ReadonlySet<string> = new Set(["min", "max", "width", "customWidth", "hidden"]);

function readColumns(root: XmlElement): ColumnRun[] {
  const cols = kid(root, "cols");
  if (cols === null) return [];
  const runs: ColumnRun[] = [];
  for (const col of kids(cols, "col")) {
    const min = Number(getAttr(col, "min")) - 1;
    const max = Math.min(Number(getAttr(col, "max")) - 1, MAX_COLS - 1);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) continue;
    const width = getAttr(col, "width");
    const widthValue = width === null ? Number.NaN : Number(width);
    runs.push({
      min,
      max,
      width: Number.isFinite(widthValue) && widthValue >= 0 ? widthValue : null,
      hidden: boolAttr(getAttr(col, "hidden"), false),
      other: col.attrs.filter((attr) => !COLUMN_OWN_ATTRS.has(attr.name)).map((attr) => [attr.name, attr.value] as const),
    });
  }
  return runs.sort((a, b) => a.min - b.min);
}

function readMerges(root: XmlElement): CellRange[] {
  const container = kid(root, "mergeCells");
  if (container === null) return [];
  const merges: CellRange[] = [];
  for (const entry of kids(container, "mergeCell")) {
    const range = tryParseA1Range(getAttr(entry, "ref") ?? "");
    if (range !== null) merges.push(range);
  }
  return merges;
}

/** The first sheet view, which carries the frozen panes. */
export function firstSheetView(root: XmlElement): XmlElement | null {
  const views = kid(root, "sheetViews");
  return views === null ? null : kid(views, "sheetView");
}

function readFrozen(root: XmlElement): FrozenPanes {
  const view = firstSheetView(root);
  const pane = view === null ? null : kid(view, "pane");
  if (pane === null) return { rows: 0, cols: 0 };
  const state = getAttr(pane, "state");
  if (state !== "frozen" && state !== "frozenSplit") return { rows: 0, cols: 0 };
  const count = (name: string): number => {
    const value = Number(getAttr(pane, name) ?? "0");
    return Number.isInteger(value) && value > 0 ? value : 0;
  };
  return { rows: Math.min(count("ySplit"), MAX_ROWS - 1), cols: Math.min(count("xSplit"), MAX_COLS - 1) };
}

export type SheetIdentity = Pick<SheetModel, "id" | "name" | "state" | "partName" | "relId" | "entry">;

/**
 * Builds the model of one worksheet from its parsed part.
 *
 * With `sourceText` (the text `doc` was parsed from) the tree is not kept:
 * rows and cells remember where they were in the document and
 * `attachSheet` parses the text again when the sheet is first written.
 */
export function readSheet(identity: SheetIdentity, doc: XmlDocument, context: ReadContext, sourceText?: string): SheetModel {
  const root = doc.root;
  if (!isNamed(root.name, "worksheet")) {
    throw new OfficeError("unsupported_format", "the sheet is not a worksheet (chart and macro sheets are not supported)");
  }
  const sheetData = kid(root, "sheetData");
  if (sheetData === null) throw corrupt("a worksheet has no sheetData");
  const format = kid(root, "sheetFormatPr");
  const positive = (name: string, fallback: number): number => {
    const value = format === null ? Number.NaN : Number(getAttr(format, name) ?? "NaN");
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const { rows, rowsUnordered, hasShared, ordered, stringRefs } = readRows(sheetData, context);
  const detached = sourceText !== undefined;
  if (detached) {
    for (const row of ordered) {
      row.el = null;
      let position = 0;
      for (const cell of row.cells.values()) cell.el = position++;
    }
  }
  return {
    ...identity,
    doc: detached ? null : doc,
    sheetData: detached ? null : sheetData,
    sourceText: detached ? sourceText : null,
    sourceRows: detached ? ordered : null,
    rows,
    rowsUnordered,
    hasShared,
    stringRefs,
    tables: [],
    notes: null,
    rowSetDirty: false,
    merges: readMerges(root),
    mergesDirty: false,
    columns: readColumns(root),
    columnsDirty: false,
    frozen: readFrozen(root),
    frozenDirty: false,
    defaultColumnWidth: positive("defaultColWidth", DEFAULT_COLUMN_WIDTH),
    defaultRowHeightPt: positive("defaultRowHeight", DEFAULT_ROW_HEIGHT),
    dirty: false,
    partDirty: false,
    unshare: false,
    dimensions: undefined,
  };
}

/**
 * Parses the sheet XML again and gives every row and cell its element back.
 * Rows and cells are matched by their position in the document, which does
 * not change while the tree is away, whatever was edited in between.
 */
export function attachSheet(sheet: SheetModel): AttachedSheet {
  if (sheet.doc !== null && sheet.sheetData !== null) return sheet as AttachedSheet;
  const doc = parseXml(sheet.sourceText ?? "");
  const sheetData = kid(doc.root, "sheetData");
  if (sheetData === null) throw corrupt("a worksheet has no sheetData");
  const sourceRows = sheet.sourceRows ?? [];
  let rowPosition = 0;
  for (const node of sheetData.children) {
    if (node.kind !== "element" || !isNamed(node.name, "row")) continue;
    const row = sourceRows[rowPosition++];
    if (row === undefined) break;
    row.el = node;
    let cells: XmlElement[] | null = null;
    for (const cell of row.cells.values()) {
      if (typeof cell.el !== "number") continue;
      if (cells === null) cells = kids(node, "c");
      cell.el = cells[cell.el] ?? null;
    }
  }
  sheet.doc = doc;
  sheet.sheetData = sheetData;
  sheet.sourceText = null;
  sheet.sourceRows = null;
  return sheet as AttachedSheet;
}
