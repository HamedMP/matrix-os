/** Sheets of a workbook: listing, adding, renaming and removing, with the reference rewriting each needs. */

import type { ColumnInfo, RowInfo, SheetInfo } from "../../api/xlsx.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { relativeTargetFor } from "../../opc/index.js";
import { appendChild, createElement, getAttr, insertBefore, lookupPrefix, parseXml, remove, setAttr } from "../../xml/index.js";
import { MAX_COLS } from "./a1.js";
import { writeCell } from "./cells.js";
import { rewriteFeatureFormulas } from "./feature-formulas.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { rewriteForRemoval, rewriteForRename } from "./refs-rewrite.js";
import { readSheet } from "./sheet-read.js";
import { sheetDimensions } from "./sheet-write.js";
import { CONTENT_TYPE_WORKSHEET, REL_WORKSHEET, freePartName, invalidateGraph } from "./state.js";
import { NS_MAIN, NS_RELATIONSHIPS, kid, kids, qualify } from "./xml-util.js";

export function sheetInfo(state: WorkbookState, sheet: SheetModel): SheetInfo {
  const columns: ColumnInfo[] = [];
  // One entry per column at most, however many runs a file declares.
  for (const run of sheet.columns) {
    if (run.width === null && !run.hidden) continue;
    for (let index = run.min; index <= run.max && columns.length < MAX_COLS; index++) {
      columns.push({ index, width: run.width ?? sheet.defaultColumnWidth, hidden: run.hidden });
    }
  }
  const rows: RowInfo[] = [];
  for (const row of sheet.rows.values()) {
    if (row.height === null && !row.hidden) continue;
    rows.push({ index: row.index, heightPt: row.height ?? sheet.defaultRowHeightPt, hidden: row.hidden });
  }
  rows.sort((a, b) => a.index - b.index);
  const dimensions = sheetDimensions(sheet);
  return {
    id: sheet.id,
    name: sheet.name,
    index: state.sheets.indexOf(sheet),
    state: sheet.state,
    dimensions: dimensions === null ? null : { start: { ...dimensions.start }, end: { ...dimensions.end } },
    defaultColumnWidth: sheet.defaultColumnWidth,
    defaultRowHeightPt: sheet.defaultRowHeightPt,
    columns,
    rows,
    mergedRanges: sheet.merges.map((range) => ({ start: { ...range.start }, end: { ...range.end } })),
    frozen: { rows: sheet.frozen.rows, cols: sheet.frozen.cols },
    pendingChangeCount: state.journal === null ? 0 : state.journal.pendingChangeCount(sheet.id),
  };
}

/** Throws `invalid_argument` unless `name` is well formed as a sheet name. */
export function checkSheetNameText(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length < 1 || name.length > 31) {
    throw new OfficeError("invalid_argument", "a sheet name has 1 to 31 characters");
  }
  if (/[:\\/?*[\]]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
    throw new OfficeError("invalid_argument", "a sheet name cannot contain : \\ / ? * [ ] or begin or end with '");
  }
}

/** Throws `invalid_argument` unless `name` can name a sheet of this workbook. `except` is the sheet being renamed. */
export function checkSheetName(state: WorkbookState, name: string, except: SheetModel | null): void {
  checkSheetNameText(name);
  const existing = state.sheetsByKey.get(name.toLowerCase());
  if (existing !== undefined && existing !== except) {
    throw new OfficeError("invalid_argument", "a sheet with this name exists");
  }
}

/**
 * Rewrites every formula of the workbook with `rewrite`: cells (telling
 * listeners about the changed ones), defined names, and the formulas of
 * conditional formats, data validations and in-workbook links.
 */
export function rewriteAllFormulas(state: WorkbookState, rewrite: (text: string, sheet: SheetModel | null) => string, skip: SheetModel | null): void {
  for (const sheet of state.sheets) {
    if (sheet === skip) continue;
    for (const row of sheet.rows.values()) {
      for (const [col, cell] of row.cells) {
        if (cell.formula === null) continue;
        const text = rewrite(cell.formula, sheet);
        if (text === cell.formula) continue;
        writeCell(state, sheet, row.index, col, { value: cell.value, formula: text, styleId: cell.styleId }, "rewrite", true);
      }
    }
  }
  for (const sheet of state.sheets) if (sheet !== skip) rewriteFeatureFormulas(sheet, (text) => rewrite(text, sheet));
  for (const name of state.names) {
    const text = rewrite(name.refersTo, null);
    if (text === name.refersTo) continue;
    name.refersTo = text;
    state.namesDirty = true;
  }
}

const EMPTY_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}"><sheetData/></worksheet>`;

export function addSheet(state: WorkbookState, name: string, index?: number): SheetModel {
  checkSheetName(state, name, null);
  const position = index === undefined ? state.sheets.length : index;
  if (!Number.isInteger(position) || position < 0 || position > state.sheets.length) {
    throw new OfficeError("invalid_argument", "sheet position is out of range");
  }
  let nextId = 1;
  for (const sheet of state.sheets) nextId = Math.max(nextId, Number(sheet.id) + 1);
  const source = state.workbookPart.name;
  const partName = freePartName(state, "worksheets/sheet", true);
  state.pkg.setPart(partName, EMPTY_SHEET, CONTENT_TYPE_WORKSHEET);
  const relationship = state.pkg.addRelationship(source, { type: REL_WORKSHEET, target: relativeTargetFor(source, partName) });
  const root = state.workbookPart.doc.root;
  const list = kid(root, "sheets") as XmlElement;
  const prefix = lookupPrefix(list, NS_RELATIONSHIPS);
  const attrs: Array<readonly [string, string]> = [
    ["name", name],
    ["sheetId", String(nextId)],
  ];
  if (prefix === null || prefix === "") attrs.push(["xmlns:r", NS_RELATIONSHIPS], ["r:id", relationship.id]);
  else attrs.push([`${prefix}:id`, relationship.id]);
  const entry = createElement(qualify(root, "sheet"), attrs);
  const after = state.sheets[position];
  if (after === undefined) appendChild(list, entry);
  else insertBefore(after.entry, entry);
  const context = { strings: state.strings, date1904: state.date1904, cellCount: 0, maxCells: state.maxCells };
  const sheet = readSheet(
    { id: String(nextId), name, state: "visible", partName, relId: relationship.id, entry },
    parseXml(EMPTY_SHEET),
    context,
  );
  state.sheets.splice(position, 0, sheet);
  state.sheetsById.set(sheet.id, sheet);
  state.sheetsByKey.set(name.toLowerCase(), sheet);
  state.workbookPart.dirty = true;
  // Local names store the position of their sheet, and formulas may now resolve the new name.
  state.namesDirty = true;
  state.calc.all = true;
  invalidateGraph(state);
  return sheet;
}

export function renameSheet(state: WorkbookState, sheet: SheetModel, name: string): void {
  checkSheetName(state, name, sheet);
  if (name === sheet.name) return;
  const oldKey = sheet.name.toLowerCase();
  state.sheetsByKey.delete(oldKey);
  state.sheetsByKey.set(name.toLowerCase(), sheet);
  sheet.name = name;
  setAttr(sheet.entry, "name", name);
  state.workbookPart.dirty = true;
  rewriteAllFormulas(state, (text) => rewriteForRename(text, oldKey, name), null);
  invalidateGraph(state);
}

export function removeSheet(state: WorkbookState, sheet: SheetModel): void {
  if (state.journal !== null && state.journal.pendingChangeCount(sheet.id) > 0) {
    throw new OfficeError("invalid_operation", "the sheet has pending changes");
  }
  if (sheet.state === "visible" && !state.sheets.some((other) => other !== sheet && other.state === "visible")) {
    throw new OfficeError("invalid_operation", "the last visible sheet cannot be removed");
  }
  const key = sheet.name.toLowerCase();
  const position = state.sheets.indexOf(sheet);
  state.sheets.splice(position, 1);
  state.sheetsById.delete(sheet.id);
  state.sheetsByKey.delete(key);
  state.calc.edited.delete(sheet);
  for (const row of sheet.rows.values()) {
    for (const cell of row.cells.values()) if (cell.value !== null || cell.formula !== null) state.cellCount--;
  }
  remove(sheet.entry);
  state.pkg.removeRelationship(state.workbookPart.name, sheet.relId);
  // The tables of the sheet go with it: a table part nothing points at would keep its name taken.
  for (const table of sheet.tables) if (state.pkg.hasPart(table.name)) state.pkg.removePart(table.name);
  state.pkg.removePart(sheet.partName);
  state.names = state.names.filter((name) => name.scope !== sheet);
  state.namesDirty = true;
  rewriteAllFormulas(state, (text) => rewriteForRemoval(text, key), null);
  // The active tab must still point at a sheet.
  const views = kid(state.workbookPart.doc.root, "bookViews");
  for (const view of views === null ? [] : kids(views, "workbookView")) {
    const firstVisible = Math.max(0, state.sheets.findIndex((other) => other.state === "visible"));
    for (const attr of ["activeTab", "firstSheet"]) {
      const value = getAttr(view, attr);
      if (value !== null && state.sheets[Number(value)]?.state !== "visible") setAttr(view, attr, String(firstVisible));
    }
  }
  state.workbookPart.dirty = true;
  state.calc.all = true;
  invalidateGraph(state);
}
