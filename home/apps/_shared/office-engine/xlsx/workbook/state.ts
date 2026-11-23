/** Lookups and bookkeeping on the workbook state that every operation shares. */

import type { FormulaAst } from "../../api/formula.js";
import type { PartName } from "../../api/opc.js";
import type { CellValue, SheetId } from "../../api/xlsx.js";
import type { XmlDocument } from "../../api/xml.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { partDirectory, relativeTargetFor } from "../../opc/index.js";
import { parseXml, serializeXml } from "../../xml/index.js";
import type { CellMutation, RawCell } from "./internals.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { NS_MAIN } from "./xml-util.js";

export const CONTENT_TYPE_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
export const CONTENT_TYPE_SHARED_STRINGS =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
export const CONTENT_TYPE_STYLES = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
export const CONTENT_TYPE_WORKBOOK = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL_WORKSHEET = `${REL_BASE}/worksheet`;
export const REL_SHARED_STRINGS = `${REL_BASE}/sharedStrings`;
export const REL_STYLES = `${REL_BASE}/styles`;

const PARSE_CACHE_LIMIT = 20_000;
/** Longest text a cell can hold. */
export const MAX_CELL_TEXT = 32_767;

export function sheetOf(state: WorkbookState, id: SheetId): SheetModel {
  const sheet = typeof id === "string" ? state.sheetsById.get(id) : undefined;
  if (sheet === undefined) throw new OfficeError("not_found", "no such sheet", { details: { sheet: String(id).slice(0, 64) } });
  return sheet;
}

/** Relationship of the workbook part whose type ends with `/suffix` (transitional or strict). */
export function workbookRelationship(state: WorkbookState, suffix: string): { id: string; part: PartName } | null {
  const source = state.workbookPart.name;
  for (const relationship of state.pkg.getRelationships(source)) {
    if (relationship.targetMode !== "Internal" || !relationship.type.endsWith(`/${suffix}`)) continue;
    return { id: relationship.id, part: state.pkg.resolveTarget(source, relationship.target) };
  }
  return null;
}

/**
 * A part name under the folder of the workbook part that no part uses yet:
 * `stem.xml` when free and `numbered` is false, otherwise `stem1.xml`, `stem2.xml`, ….
 */
export function freePartName(state: WorkbookState, stem: string, numbered: boolean): PartName {
  const directory = partDirectory(state.workbookPart.name);
  if (!numbered && !state.pkg.hasPart(`${directory}${stem}.xml`)) return `${directory}${stem}.xml`;
  for (let n = 1; ; n++) {
    const name = `${directory}${stem}${n}.xml`;
    if (!state.pkg.hasPart(name)) return name;
  }
}

/** Adds text to the shared string table, creating the part the first time. */
export function addSharedString(state: WorkbookState, text: string): number {
  return state.strings.add(text, (): XmlDocument => {
    const name = freePartName(state, "sharedStrings", false);
    const doc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS_MAIN}" count="0" uniqueCount="0"/>`);
    state.pkg.setPart(name, serializeXml(doc), CONTENT_TYPE_SHARED_STRINGS);
    state.pkg.addRelationship(state.workbookPart.name, {
      type: REL_SHARED_STRINGS,
      target: relativeTargetFor(state.workbookPart.name, name),
    });
    state.stringsPartName = name;
    return doc;
  });
}

/** Removes the calculation chain: it lists formula cells in order and is wrong once formulas change. */
export function dropCalcChain(state: WorkbookState): void {
  if (state.calcChainDropped) return;
  state.calcChainDropped = true;
  const chain = workbookRelationship(state, "calcChain");
  if (chain === null) return;
  state.pkg.removeRelationship(state.workbookPart.name, chain.id);
  state.pkg.removePart(chain.part);
}

/** Forgets the dependency graph; the next calculation rebuilds it. */
export function invalidateGraph(state: WorkbookState): void {
  state.calc.graph = null;
}

export function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  return a.code === b.code;
}

export function sameRaw(a: RawCell, b: RawCell): boolean {
  return a.formula === b.formula && a.styleId === b.styleId && sameValue(a.value, b.value);
}

/** A value as the handle hands it out: error objects are copied so callers cannot change the model. */
export function copyValue(value: CellValue): CellValue {
  return value !== null && typeof value === "object" ? { kind: "error", code: value.code } : value;
}

/** Parses a formula once per text. Null when it does not parse or no formula engine is attached. */
export function parseCached(state: WorkbookState, text: string): FormulaAst | null {
  const formula = state.formula;
  if (formula === null) return null;
  const cached = state.parseCache.get(text);
  if (cached !== undefined) return cached;
  let ast: FormulaAst | null = null;
  try {
    ast = formula.parseFormula(text);
  } catch (error) {
    // An unsupported or malformed formula keeps its stored value; anything else is a real failure.
    if (!isOfficeError(error, "formula_error", "limit_exceeded")) throw error;
  }
  if (state.parseCache.size >= PARSE_CACHE_LIMIT) state.parseCache.clear();
  state.parseCache.set(text, ast);
  return ast;
}

export function notify(state: WorkbookState, mutation: CellMutation): void {
  for (const listener of state.listeners) listener(mutation);
}
