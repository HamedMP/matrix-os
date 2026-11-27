/** What a workbook handle gives the change journal: see `WorkbookInternals` in `./internals.ts`. */

import type { OpcPackage, PartName } from "../../api/opc.js";
import type { Workbook } from "../../api/xlsx.js";
import type { XmlDocument } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { partNamesEqual } from "../../opc/index.js";
import { requireAddress } from "./a1.js";
import { applyCellMarkup, parseCellMarkup } from "./cell-markup.js";
import { checkValue, findCell, readRaw, writeCell } from "./cells.js";
import { captureSheetFeatures, readableSheetFeatures, restoreSheetFeatures, rewriteSheetFeatures } from "./features.js";
import { captureLinkedFeatures, holdsLinkedFeatures, readableLinkedFeatures, restoreLinkedFeatures, rewriteLinkedFeatures } from "./linked-features.js";
import type { CellMutationListener, RawCell, WorkbookInternals, WorkbookJournal } from "./internals.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { flushNames } from "./names.js";
import { attachSheet } from "./sheet-read.js";
import { flushSheet } from "./sheet-write.js";
import { addSharedString, sheetOf } from "./state.js";
import { structureRewritesExceed } from "./structure.js";

const MAX_LISTENERS = 16;

export function makeInternals(workbook: Workbook, state: WorkbookState): WorkbookInternals {
  const sheetByPart = (name: PartName): SheetModel | undefined =>
    state.sheets.find((sheet) => partNamesEqual(sheet.partName, name));
  return {
    workbook,
    get package(): OpcPackage {
      return state.pkg;
    },
    get workbookPartName(): PartName {
      return state.workbookPart.name;
    },
    sheetPartName: (sheet) => sheetOf(state, sheet).partName,
    hasSheet: (sheet) => state.sheetsById.has(sheet),
    readRawCell(sheet, address): RawCell {
      const model = sheetOf(state, sheet);
      requireAddress(address);
      return readRaw(model, address.row, address.col);
    },
    writeRawCell(sheet, address, cell, markup = null): void {
      const model = sheetOf(state, sheet);
      requireAddress(address);
      const next: RawCell = { value: checkValue(cell.value), formula: cell.formula, styleId: state.styles.clamp(cell.styleId) };
      writeCell(state, model, address.row, address.col, next, null);
      if (markup === null) return;
      const rec = findCell(model, address.row, address.col);
      const row = model.rows.get(address.row);
      const element = rec === undefined ? null : parseCellMarkup(markup, attachSheet(model).doc.root);
      if (element !== null && rec !== undefined && row !== undefined) applyCellMarkup(rec, row, element);
    },
    onCellMutation(listener: CellMutationListener): () => void {
      if (typeof listener !== "function") throw new OfficeError("invalid_argument", "a listener is a function");
      if (state.listeners.length >= MAX_LISTENERS) throw new OfficeError("limit_exceeded", "too many mutation listeners");
      state.listeners.push(listener);
      return () => {
        const at = state.listeners.indexOf(listener);
        if (at >= 0) state.listeners.splice(at, 1);
      };
    },
    getPartXml(name): XmlDocument | null {
      if (partNamesEqual(name, state.workbookPart.name)) {
        flushNames(state);
        return state.workbookPart.doc;
      }
      const sheet = sheetByPart(name);
      if (sheet !== undefined) {
        flushSheet(sheet, (text) => addSharedString(state, text));
        return attachSheet(sheet).doc;
      }
      if (state.stringsPartName !== null && partNamesEqual(name, state.stringsPartName)) return state.strings.doc;
      if (partNamesEqual(name, state.stylesPart.name)) return state.stylesPart.doc;
      return null;
    },
    markPartDirty(name): void {
      const sheet = sheetByPart(name);
      if (sheet !== undefined) sheet.partDirty = true;
      else if (partNamesEqual(name, state.workbookPart.name)) state.workbookPart.dirty = true;
      else if (state.stringsPartName !== null && partNamesEqual(name, state.stringsPartName)) state.strings.dirty = true;
      else if (partNamesEqual(name, state.stylesPart.name)) state.styles.dirty = true;
    },
    async readPartText(name): Promise<string | null> {
      return state.pkg.hasPart(name) ? state.pkg.getPartText(name) : null;
    },
    captureSheetFeatures: (sheet, axis, index, count) => captureSheetFeatures(state, sheetOf(state, sheet), axis, index, count),
    structureRewritesExceed: (sheet, axis, index, count, limit) =>
      structureRewritesExceed(state, sheetOf(state, sheet), { axis, index, count }, limit),
    readableSheetFeatures,
    restoreSheetFeatures: (sheet, features) => restoreSheetFeatures(state, sheetOf(state, sheet), features),
    rewriteSheetFeatures,
    captureLinkedFeatures: (sheet, axis, index, count) => captureLinkedFeatures(state, sheetOf(state, sheet), { axis, index, count: -count }),
    holdsLinkedFeatures: (linked) => holdsLinkedFeatures(state, linked),
    readableLinkedFeatures,
    restoreLinkedFeatures: (linked) => restoreLinkedFeatures(state, linked),
    rewriteLinkedFeatures,
    setJournal(journal: WorkbookJournal | null): void {
      state.journal = journal;
    },
    getJournal: () => state.journal,
  };
}
