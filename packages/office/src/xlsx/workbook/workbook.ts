/** The workbook handle: checks arguments and hands each operation to the module that implements it. */

import type { OpcPackage, PartName } from "../../api/opc.js";
import type {
  Cell,
  CellAddress,
  CellChange,
  CellRange,
  CellStyle,
  CellStylePatch,
  CellValue,
  DefinedName,
  FrozenPanes,
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
  Workbook,
} from "../../api/xlsx.js";
import type { XmlDocument } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { partNamesEqual, relativeTargetFor } from "../../opc/index.js";
import { serializeXml } from "../../xml/index.js";
import { MAX_COLS, MAX_ROWS, requireAddress, requireRange } from "./a1.js";
import { checkFormula, dependents, needsRecalc, precedents, recalc } from "./calc.js";
import { guardArrayWrite } from "./arrays.js";
import { checkTableHeaderWrites, flushTables, holdsTableHeader } from "./tables.js";
import {
  cellView,
  checkValue,
  clearRange,
  ensureRow,
  findCell,
  readRaw,
  requireSmallRange,
  setStyle,
  writeCell,
} from "./cells.js";
import { parseCellInput } from "./input.js";
import { makeInternals } from "./handle-internals.js";
import { registerInternals } from "./internals.js";
import { setColumnWidth, setMerge, unmerge } from "./layout.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { flushNames, listNames, removeName, setName } from "./names.js";
import { flushNotes } from "./notes.js";
import { attachSheet } from "./sheet-read.js";
import { flushSheet } from "./sheet-write.js";
import { addSheet, removeSheet, renameSheet, sheetInfo } from "./sheets.js";
import { CONTENT_TYPE_STYLES, REL_STYLES, addSharedString, sheetOf } from "./state.js";
import { applyStructuralOp } from "./structure.js";
import { applyStylePatch } from "./style-write.js";

/** Calculation runs one save makes at most: each takes 200 000 formulas, a workbook holds 2 000 000 cells. */
const MAX_SAVE_RUNS = 64;

function requireCount(value: number, limit: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= limit) {
    throw new OfficeError("invalid_argument", `${what} is out of range`);
  }
}

/** Writes every pending model change into the package parts. */
export function syncParts(state: WorkbookState): void {
  const pkg = state.pkg;
  const strings = (text: string): number => addSharedString(state, text);
  // Cells may have come or gone when a sheet is written, or when the list of sheets changed.
  let cellsChanged = state.workbookPart.dirty;
  for (const sheet of state.sheets) {
    if (sheet.dirty) cellsChanged = true;
    flushSheet(sheet, strings);
    if (!sheet.partDirty) continue;
    pkg.setPart(sheet.partName, serializeXml(attachSheet(sheet).doc));
    sheet.partDirty = false;
  }
  if (cellsChanged) {
    let references = 0;
    for (const sheet of state.sheets) references += sheet.stringRefs;
    state.strings.setReferenceCount(references);
  }
  flushTables(pkg, state.sheets);
  flushNotes(pkg, state.sheets);
  flushNames(state);
  if (state.workbookPart.dirty) {
    pkg.setPart(state.workbookPart.name, serializeXml(state.workbookPart.doc));
    state.workbookPart.dirty = false;
  }
  if (state.strings.dirty && state.strings.doc !== null && state.stringsPartName !== null) {
    pkg.setPart(state.stringsPartName, serializeXml(state.strings.doc));
    state.strings.dirty = false;
  }
  if (state.styles.dirty) {
    const part = state.stylesPart;
    if (!state.stylesInPackage) {
      pkg.setPart(part.name, serializeXml(part.doc), CONTENT_TYPE_STYLES);
      pkg.addRelationship(state.workbookPart.name, { type: REL_STYLES, target: relativeTargetFor(state.workbookPart.name, part.name) });
      state.stylesInPackage = true;
    } else {
      pkg.setPart(part.name, serializeXml(part.doc));
    }
    state.styles.dirty = false;
  }
}

export class WorkbookHandle implements Workbook {
  readonly #state: WorkbookState;

  constructor(state: WorkbookState) {
    this.#state = state;
    registerInternals(this, makeInternals(this, state));
  }

  get package(): OpcPackage {
    return this.#state.pkg;
  }

  listSheets(): SheetInfo[] {
    return this.#state.sheets.map((sheet) => sheetInfo(this.#state, sheet));
  }

  getSheet(sheet: SheetId): SheetInfo {
    return sheetInfo(this.#state, sheetOf(this.#state, sheet));
  }

  getSheetByName(name: string): SheetInfo | null {
    const sheet = typeof name === "string" ? this.#state.sheetsByKey.get(name.toLowerCase()) : undefined;
    return sheet === undefined ? null : sheetInfo(this.#state, sheet);
  }

  addSheet(name: string, index?: number): SheetInfo {
    return sheetInfo(this.#state, addSheet(this.#state, name, index));
  }

  renameSheet(sheet: SheetId, name: string): void {
    renameSheet(this.#state, sheetOf(this.#state, sheet), name);
  }

  removeSheet(sheet: SheetId): void {
    removeSheet(this.#state, sheetOf(this.#state, sheet));
  }

  getCell(sheet: SheetId, address: CellAddress): Cell {
    const model = sheetOf(this.#state, sheet);
    requireAddress(address);
    return cellView(this.#state, model, address.row, address.col);
  }

  getRange(sheet: SheetId, range: CellRange): Cell[][] {
    const model = sheetOf(this.#state, sheet);
    const { start, end } = requireRange(range);
    requireSmallRange({ start, end });
    const rows: Cell[][] = [];
    for (let row = start.row; row <= end.row; row++) {
      const line: Cell[] = [];
      for (let col = start.col; col <= end.col; col++) line.push(cellView(this.#state, model, row, col));
      rows.push(line);
    }
    return rows;
  }

  getStyle(styleId: StyleId): CellStyle {
    return this.#state.styles.getStyle(styleId);
  }

  setCell(sheet: SheetId, address: CellAddress, value: CellValue): void {
    const model = sheetOf(this.#state, sheet);
    requireAddress(address);
    const checked = checkValue(value);
    guardArrayWrite(this.#state, model, { start: address, end: address }, null);
    checkTableHeaderWrites(model, [{ ...address, value: checked, formula: null }]);
    const styleId = findCell(model, address.row, address.col)?.styleId ?? 0;
    writeCell(this.#state, model, address.row, address.col, { value: checked, formula: null, styleId }, "edit");
  }

  setRange(sheet: SheetId, start: CellAddress, values: ReadonlyArray<ReadonlyArray<CellValue>>): void {
    const model = sheetOf(this.#state, sheet);
    requireAddress(start);
    if (!Array.isArray(values)) throw new OfficeError("invalid_argument", "values must be rows of cells");
    const checked: CellValue[][] = [];
    for (const line of values) {
      if (!Array.isArray(line)) throw new OfficeError("invalid_argument", "values must be rows of cells");
      checked.push((line as readonly CellValue[]).map(checkValue));
    }
    if (start.row + checked.length > MAX_ROWS) throw new OfficeError("invalid_argument", "the values do not fit on the sheet");
    let width = 0;
    for (const line of checked) {
      if (start.col + line.length > MAX_COLS) throw new OfficeError("invalid_argument", "the values do not fit on the sheet");
      width = Math.max(width, line.length);
    }
    if (checked.length > 0 && width > 0) {
      const bounds = { start, end: { row: start.row + checked.length - 1, col: start.col + width - 1 } };
      // Rows may differ in length: a cell is written when its row reaches its column.
      guardArrayWrite(this.#state, model, bounds, (row, col) => col - start.col < (checked[row - start.row] as CellValue[]).length);
      if (model.tables.length > 0 && holdsTableHeader(model, bounds)) {
        const writes = checked.flatMap((line, r) => line.map((value, c) => ({ row: start.row + r, col: start.col + c, value, formula: null })));
        checkTableHeaderWrites(model, writes);
      }
    }
    for (let r = 0; r < checked.length; r++) {
      const line = checked[r] as CellValue[];
      for (let c = 0; c < line.length; c++) {
        const row = start.row + r;
        const col = start.col + c;
        const styleId = findCell(model, row, col)?.styleId ?? 0;
        writeCell(this.#state, model, row, col, { value: line[c] as CellValue, formula: null, styleId }, "edit");
      }
    }
  }

  setFormula(sheet: SheetId, address: CellAddress, formula: string | null): void {
    const model = sheetOf(this.#state, sheet);
    requireAddress(address);
    const current = readRaw(model, address.row, address.col);
    if (formula === null) {
      if (current.formula === null) return;
      guardArrayWrite(this.#state, model, { start: address, end: address }, null);
      writeCell(this.#state, model, address.row, address.col, { value: current.value, formula: null, styleId: current.styleId }, "edit");
      return;
    }
    if (typeof formula !== "string") throw new OfficeError("invalid_argument", "a formula is text or null");
    const text = formula.startsWith("=") ? formula.slice(1) : formula;
    checkFormula(this.#state, text);
    guardArrayWrite(this.#state, model, { start: address, end: address }, null);
    checkTableHeaderWrites(model, [{ ...address, value: null, formula: text }]);
    if (text === current.formula) return;
    // The value is unknown until the next calculation.
    writeCell(this.#state, model, address.row, address.col, { value: null, formula: text, styleId: current.styleId }, "edit");
  }

  setCellInput(sheet: SheetId, address: CellAddress, input: string): void {
    const state = this.#state;
    const model = sheetOf(state, sheet);
    requireAddress(address);
    if (typeof input !== "string") throw new OfficeError("invalid_argument", "input must be text");
    const parsed = parseCellInput(input, state.date1904);
    if (parsed.kind === "formula") {
      this.setFormula(sheet, address, parsed.text);
      return;
    }
    guardArrayWrite(state, model, { start: address, end: address }, null);
    let styleId = findCell(model, address.row, address.col)?.styleId ?? 0;
    const value = parsed.kind === "clear" ? null : checkValue(parsed.value);
    checkTableHeaderWrites(model, [{ ...address, value, formula: null }]);
    if (parsed.kind === "value" && parsed.format !== null && state.styles.numberFormat(styleId) === "General") {
      styleId = applyStylePatch(state.styles, styleId, { numberFormat: parsed.format });
    }
    writeCell(state, model, address.row, address.col, { value, formula: null, styleId }, "edit");
  }

  clearRange(sheet: SheetId, range: CellRange, what: "contents" | "formats" | "all" = "contents"): void {
    const model = sheetOf(this.#state, sheet);
    if (what !== "contents" && what !== "formats" && what !== "all") {
      throw new OfficeError("invalid_argument", "clear contents, formats or all");
    }
    const checked = requireRange(range);
    if (what !== "formats") guardArrayWrite(this.#state, model, checked, null);
    if (what !== "formats" && holdsTableHeader(model, checked)) {
      throw new OfficeError("invalid_operation", "the header of a table cannot be cleared");
    }
    clearRange(this.#state, model, checked, what);
  }

  setStyle(sheet: SheetId, range: CellRange, patch: CellStylePatch): void {
    setStyle(this.#state, sheetOf(this.#state, sheet), requireRange(range), patch);
  }

  insertRows(sheet: SheetId, index: number, count: number): void {
    this.#structure(sheet, "row", index, count, 1);
  }

  deleteRows(sheet: SheetId, index: number, count: number): void {
    this.#structure(sheet, "row", index, count, -1);
  }

  insertColumns(sheet: SheetId, index: number, count: number): void {
    this.#structure(sheet, "col", index, count, 1);
  }

  deleteColumns(sheet: SheetId, index: number, count: number): void {
    this.#structure(sheet, "col", index, count, -1);
  }

  #structure(sheet: SheetId, axis: "row" | "col", index: number, count: number, sign: 1 | -1): void {
    const model = sheetOf(this.#state, sheet);
    if (!Number.isInteger(count) || count < 1) throw new OfficeError("invalid_argument", "count must be 1 or more");
    applyStructuralOp(this.#state, model, { axis, index, count: sign * count });
  }

  setColumnWidth(sheet: SheetId, col: number, width: number | null): void {
    const model = sheetOf(this.#state, sheet);
    requireCount(col, MAX_COLS, "column");
    if (width !== null && !(typeof width === "number" && width >= 0 && width <= 255)) {
      throw new OfficeError("invalid_argument", "a column width is 0 to 255 characters");
    }
    setColumnWidth(model, col, width);
  }

  setRowHeight(sheet: SheetId, row: number, heightPt: number | null): void {
    const model = sheetOf(this.#state, sheet);
    requireCount(row, MAX_ROWS, "row");
    if (heightPt !== null && !(typeof heightPt === "number" && heightPt >= 0 && heightPt <= 409)) {
      throw new OfficeError("invalid_argument", "a row height is 0 to 409 points");
    }
    if (heightPt === null && !model.rows.has(row)) return;
    const record = ensureRow(model, row);
    if (record.height === heightPt) return;
    record.height = heightPt;
    record.dirty = true;
    model.dirty = true;
  }

  mergeCells(sheet: SheetId, range: CellRange): void {
    setMerge(this.#state, sheetOf(this.#state, sheet), requireRange(range));
  }

  unmergeCells(sheet: SheetId, range: CellRange): void {
    unmerge(sheetOf(this.#state, sheet), requireRange(range));
  }

  setFrozenPanes(sheet: SheetId, frozen: FrozenPanes): void {
    const model = sheetOf(this.#state, sheet);
    if (frozen === null || typeof frozen !== "object") throw new OfficeError("invalid_argument", "frozen panes need rows and cols");
    requireCount(frozen.rows, MAX_ROWS, "frozen rows");
    requireCount(frozen.cols, MAX_COLS, "frozen columns");
    if (model.frozen.rows === frozen.rows && model.frozen.cols === frozen.cols) return;
    model.frozen = { rows: frozen.rows, cols: frozen.cols };
    model.frozenDirty = true;
    model.dirty = true;
  }

  listDefinedNames(): DefinedName[] {
    return listNames(this.#state);
  }

  setDefinedName(name: DefinedName): void {
    setName(this.#state, name);
  }

  removeDefinedName(name: string, scope?: SheetId | null): boolean {
    return removeName(this.#state, name, scope);
  }

  recalc(options?: RecalcOptions): RecalcResult {
    return recalc(this.#state, options, true);
  }

  precedents(sheet: SheetId, address: CellAddress): SheetRangeRef[] {
    const model = sheetOf(this.#state, sheet);
    requireAddress(address);
    return precedents(this.#state, model, address);
  }

  dependents(sheet: SheetId, address: CellAddress): SheetCellRef[] {
    const model = sheetOf(this.#state, sheet);
    requireAddress(address);
    return dependents(this.#state, model, address);
  }

  beginProposal(options: ProposalOptions): string {
    const journal = this.#state.journal;
    if (journal === null) throw new OfficeError("invalid_operation", "this workbook has no change journal");
    return journal.beginProposal(options);
  }

  endProposal(): void {
    this.#state.journal?.endProposal();
  }

  listProposals(): Proposal[] {
    return this.#state.journal?.listProposals() ?? [];
  }

  listChanges(): CellChange[] {
    return this.#state.journal?.listChanges() ?? [];
  }

  acceptChanges(ids: readonly string[] | "all"): ResolveChangesResult {
    return this.#resolve(ids, true);
  }

  rejectChanges(ids: readonly string[] | "all"): ResolveChangesResult {
    return this.#resolve(ids, false);
  }

  #resolve(ids: readonly string[] | "all", accept: boolean): ResolveChangesResult {
    const journal = this.#state.journal;
    if (journal !== null) return accept ? journal.acceptChanges(ids) : journal.rejectChanges(ids);
    if (ids === "all" || ids.length === 0) return { resolvedIds: [], restored: [], stale: [] };
    throw new OfficeError("stale_reference", "no such change");
  }

  async save(): Promise<Uint8Array> {
    const state = this.#state;
    // One run is bounded; a file is not saved with formulas a bound left behind.
    for (let runs = 0; runs < MAX_SAVE_RUNS && needsRecalc(state); runs++) recalc(state, undefined, false);
    state.journal?.beforeSave();
    syncParts(state);
    return state.pkg.save();
  }
}

/** The state behind a handle, for the modules of this folder (CSV import, tests of internals). */
const states = new WeakMap<object, WorkbookState>();

export function createHandle(state: WorkbookState): WorkbookHandle {
  const handle = new WorkbookHandle(state);
  states.set(handle, state);
  return handle;
}

/** As {@link stateOf}, with null for a workbook that is not a handle of this engine. */
export function findState(workbook: Workbook): WorkbookState | null {
  return states.get(workbook) ?? null;
}

export function stateOf(workbook: Workbook): WorkbookState {
  const state = states.get(workbook);
  if (state === undefined) throw new OfficeError("invalid_argument", "not a workbook handle of this engine");
  return state;
}
