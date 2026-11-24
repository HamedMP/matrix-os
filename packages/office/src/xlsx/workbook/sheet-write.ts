/**
 * Brings the XML of a worksheet up to date with its model.
 *
 * Only what changed is rewritten: a row is touched when one of its cells,
 * its position or its height changed, and the children of `sheetData` are
 * rebuilt only when rows were added, removed or moved.
 */

import type { CellRange } from "../../api/xlsx.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { createElement, getAttr, prependChild, remove, removeAttr, setAttr } from "../../xml/index.js";
import { columnLabel, formatA1, formatA1Range } from "./a1.js";
import { type AttachedSheet, CLEAN, type CellRec, DIRTY_CONTENT, DIRTY_STYLE, type RowRec, type SheetModel } from "./model.js";
import { attachSheet, firstSheetView } from "./sheet-read.js";
import { encodeCellText, insertInOrder, isNamed, kid, kids, needsSpacePreserve, qualify, setChildren } from "./xml-util.js";

export const WORKSHEET_ORDER = [
  "sheetPr",
  "dimension",
  "sheetViews",
  "sheetFormatPr",
  "cols",
  "sheetData",
  "sheetCalcPr",
  "sheetProtection",
  "protectedRanges",
  "scenarios",
  "autoFilter",
  "sortState",
  "dataConsolidate",
  "customSheetViews",
  "mergeCells",
  "phoneticPr",
  "conditionalFormatting",
  "dataValidations",
  "hyperlinks",
  "printOptions",
  "pageMargins",
  "pageSetup",
  "headerFooter",
  "rowBreaks",
  "colBreaks",
  "customProperties",
  "cellWatches",
  "ignoredErrors",
  "smartTags",
  "drawing",
  "legacyDrawing",
  "legacyDrawingHF",
  "picture",
  "oleObjects",
  "controls",
  "webPublishItems",
  "tableParts",
  "extLst",
];
const SHEET_VIEW_ORDER = ["pane", "selection", "pivotSelection", "extLst"];

/** Adds text to the shared string table and returns its index. */
export type StringSink = (text: string) => number;

/** The smallest rectangle that holds every cell with a value, a formula or a format. Cached on the sheet. */
export function sheetDimensions(sheet: SheetModel): CellRange | null {
  if (sheet.dimensions !== undefined) return sheet.dimensions;
  let top = Number.POSITIVE_INFINITY;
  let bottom = -1;
  let left = Number.POSITIVE_INFINITY;
  let right = -1;
  for (const row of sheet.rows.values()) {
    let used = false;
    for (const [col, cell] of row.cells) {
      if (cell.value === null && cell.formula === null && cell.styleId === 0) continue;
      used = true;
      if (col < left) left = col;
      if (col > right) right = col;
    }
    if (used) {
      if (row.index < top) top = row.index;
      if (row.index > bottom) bottom = row.index;
    }
  }
  sheet.dimensions = bottom < 0 ? null : { start: { row: top, col: left }, end: { row: bottom, col: right } };
  return sheet.dimensions;
}

function numberText(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function valueElement(reference: XmlElement, text: string): XmlElement {
  return createElement(qualify(reference, "v"), needsSpacePreserve(text) ? { "xml:space": "preserve" } : undefined, [text]);
}

function buildCell(reference: XmlElement, cell: CellRec, row: number, col: number, strings: StringSink): XmlElement {
  const attrs: Array<[string, string]> = [["r", columnLabel(col) + String(row + 1)]];
  if (cell.styleId !== 0) attrs.push(["s", String(cell.styleId)]);
  const children: XmlElement[] = [];
  const value = cell.value;
  if (cell.formula !== null) {
    const extra = cell.extra;
    const formulaAttrs: Array<readonly [string, string]> = extra === null ? [] : [...extra.attrs];
    if (extra !== null && extra.ref !== null) formulaAttrs.push(["ref", formatA1Range(extra.ref)]);
    children.push(createElement(qualify(reference, "f"), formulaAttrs, [cell.formula]));
  }
  if (typeof value === "number") {
    children.push(valueElement(reference, Number.isFinite(value) ? numberText(value) : "0"));
  } else if (typeof value === "string") {
    if (cell.formula !== null) {
      attrs.push(["t", "str"]);
      children.push(valueElement(reference, encodeCellText(value)));
    } else {
      attrs.push(["t", "s"]);
      children.push(valueElement(reference, String(strings(value))));
    }
  } else if (typeof value === "boolean") {
    attrs.push(["t", "b"]);
    children.push(valueElement(reference, value ? "1" : "0"));
  } else if (value !== null) {
    attrs.push(["t", "e"]);
    children.push(valueElement(reference, value.code));
  }
  return createElement(qualify(reference, "c"), attrs, children);
}

function syncAttr(element: XmlElement, name: string, value: string | null): void {
  const current = getAttr(element, name);
  if (current === value) return;
  if (value === null) removeAttr(element, name);
  else setAttr(element, name, value);
}

export const ROW_MODEL_ATTRS: ReadonlySet<string> = new Set(["r", "spans", "ht", "customHeight", "hidden"]);

/** True when a row element carries nothing beyond what the model holds (number, height, visibility). */
function isBareRow(element: XmlElement): boolean {
  for (const attr of element.attrs) if (!ROW_MODEL_ATTRS.has(attr.name)) return false;
  return true;
}

/** Writes one row. Returns false when the row is empty and should leave the sheet. */
function flushRow(sheet: AttachedSheet, row: RowRec, strings: StringSink): boolean {
  if (row.cells.size === 0 && row.height === null && !row.hidden && row.attrs === undefined && (row.el === null || isBareRow(row.el))) return false;
  const data = sheet.sheetData;
  let element = row.el;
  if (element === null) {
    element = createElement(qualify(data, "row"), [["r", String(row.index + 1)], ...(row.attrs ?? [])]);
    row.el = element;
    row.attrs = undefined;
    sheet.rowSetDirty = true;
  }
  syncAttr(element, "r", String(row.index + 1));
  removeAttr(element, "spans");
  if (row.height === null) {
    removeAttr(element, "ht");
    removeAttr(element, "customHeight");
  } else if (Number(getAttr(element, "ht") ?? "NaN") !== row.height) {
    setAttr(element, "ht", String(row.height));
    setAttr(element, "customHeight", "1");
  }
  syncAttr(element, "hidden", row.hidden ? "1" : getAttr(element, "hidden") === null ? null : "0");
  const cols = [...row.cells.keys()].sort((a, b) => a - b);
  const children: XmlChildNode[] = [];
  for (const col of cols) {
    const cell = row.cells.get(col) as CellRec;
    let cellElement = cell.el;
    if (cellElement === null || typeof cellElement === "number" || (cell.dirty & DIRTY_CONTENT) !== 0) {
      cellElement = buildCell(data, cell, row.index, col, strings);
      cell.el = cellElement;
    } else {
      if ((cell.dirty & DIRTY_STYLE) !== 0) syncAttr(cellElement, "s", cell.styleId === 0 ? null : String(cell.styleId));
      syncAttr(cellElement, "r", columnLabel(col) + String(row.index + 1));
    }
    cell.dirty = CLEAN;
    children.push(cellElement);
  }
  for (const node of element.children) {
    if (node.kind === "element" && !isNamed(node.name, "c")) children.push(node);
  }
  setChildren(element, children);
  row.dirty = false;
  return true;
}

function flushMerges(sheet: AttachedSheet): void {
  const root = sheet.doc.root;
  const existing = kid(root, "mergeCells");
  if (existing !== null) remove(existing);
  if (sheet.merges.length > 0) {
    const entries = sheet.merges.map((range) => createElement(qualify(root, "mergeCell"), { ref: formatA1Range(range) }));
    insertInOrder(root, createElement(qualify(root, "mergeCells"), { count: String(entries.length) }, entries), WORKSHEET_ORDER);
  }
  sheet.mergesDirty = false;
}

function flushColumns(sheet: AttachedSheet): void {
  const root = sheet.doc.root;
  const existing = kid(root, "cols");
  if (existing !== null) remove(existing);
  if (sheet.columns.length > 0) {
    const entries = sheet.columns.map((run) => {
      const attrs: Array<readonly [string, string]> = [
        ["min", String(run.min + 1)],
        ["max", String(run.max + 1)],
      ];
      if (run.width !== null) attrs.push(["width", String(run.width)], ["customWidth", "1"]);
      if (run.hidden) attrs.push(["hidden", "1"]);
      return createElement(qualify(root, "col"), [...attrs, ...run.other]);
    });
    insertInOrder(root, createElement(qualify(root, "cols"), undefined, entries), WORKSHEET_ORDER);
  }
  sheet.columnsDirty = false;
}

function flushFrozen(sheet: AttachedSheet): void {
  const root = sheet.doc.root;
  const { rows, cols } = sheet.frozen;
  let view = firstSheetView(root);
  if (view === null) {
    if (rows === 0 && cols === 0) {
      sheet.frozenDirty = false;
      return;
    }
    view = createElement(qualify(root, "sheetView"), { workbookViewId: "0" });
    let views = kid(root, "sheetViews");
    if (views === null) {
      views = createElement(qualify(root, "sheetViews"));
      insertInOrder(root, views, WORKSHEET_ORDER);
    }
    prependChild(views, view);
  }
  const pane = kid(view, "pane");
  if (pane !== null) remove(pane);
  for (const selection of kids(view, "selection")) remove(selection);
  if (rows > 0 || cols > 0) {
    const active = rows > 0 && cols > 0 ? "bottomRight" : rows > 0 ? "bottomLeft" : "topRight";
    const attrs: Array<readonly [string, string]> = [];
    if (cols > 0) attrs.push(["xSplit", String(cols)]);
    if (rows > 0) attrs.push(["ySplit", String(rows)]);
    attrs.push(["topLeftCell", formatA1({ row: rows, col: cols })], ["activePane", active], ["state", "frozen"]);
    prependChild(view, createElement(qualify(root, "pane"), attrs));
    const panes = rows > 0 && cols > 0 ? ["topRight", "bottomLeft", "bottomRight"] : [active];
    for (const name of panes) insertInOrder(view, createElement(qualify(root, "selection"), { pane: name }), SHEET_VIEW_ORDER);
  }
  sheet.frozenDirty = false;
}

/** Writes every pending change of the sheet model into its XML. */
export function flushSheet(model: SheetModel, strings: StringSink): void {
  if (!model.dirty) return;
  const sheet = attachSheet(model);
  if (sheet.hasShared && !sheet.unshare) {
    // A member of a shared formula whose content changed (an edit, or a new result) is written
    // on its own; its group then has to be written out too, or the others lose their master.
    scan: for (const row of sheet.rows.values()) {
      if (!row.dirty) continue;
      for (const cell of row.cells.values()) {
        if (cell.shared >= 0 && (cell.dirty & DIRTY_CONTENT) !== 0) {
          sheet.unshare = true;
          break scan;
        }
      }
    }
  }
  if (sheet.unshare && sheet.hasShared) {
    for (const row of sheet.rows.values()) {
      for (const cell of row.cells.values()) {
        if (cell.shared < 0) continue;
        cell.shared = -1;
        cell.dirty |= DIRTY_CONTENT;
        row.dirty = true;
      }
    }
    sheet.hasShared = false;
  }
  sheet.unshare = false;
  if (sheet.rowSetDirty || sheet.rowsUnordered) {
    const ordered = [...sheet.rows.values()].sort((a, b) => a.index - b.index);
    sheet.rows = new Map(ordered.map((row) => [row.index, row] as const));
    sheet.rowsUnordered = false;
  }
  for (const row of sheet.rows.values()) {
    if (!row.dirty) continue;
    if (!flushRow(sheet, row, strings)) {
      sheet.rows.delete(row.index);
      sheet.rowSetDirty = true;
    }
  }
  if (sheet.rowSetDirty) {
    const elements: XmlElement[] = [];
    for (const row of sheet.rows.values()) if (row.el !== null) elements.push(row.el);
    setChildren(sheet.sheetData, elements);
    sheet.rowSetDirty = false;
  }
  if (sheet.mergesDirty) flushMerges(sheet);
  if (sheet.columnsDirty) flushColumns(sheet);
  if (sheet.frozenDirty) flushFrozen(sheet);
  const dimension = kid(sheet.doc.root, "dimension");
  if (dimension !== null) {
    const dimensions = sheetDimensions(sheet);
    syncAttr(dimension, "ref", dimensions === null ? "A1" : formatA1Range(dimensions));
  }
  // The cells that point into the shared string table, for the count that part states.
  let stringRefs = 0;
  for (const row of sheet.rows.values()) {
    if (row.el === null) continue;
    for (const node of row.el.children) {
      if (node.kind === "element" && isNamed(node.name, "c") && getAttr(node, "t") === "s") stringRefs++;
    }
  }
  sheet.stringRefs = stringRefs;
  sheet.dirty = false;
  sheet.partDirty = true;
}
