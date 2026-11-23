/** Defined names of a workbook. */

import type { DefinedName } from "../../api/xlsx.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { createElement, getAttr, remove, removeAttr, setAttr, setTextContent, textContent } from "../../xml/index.js";
import { tryParseA1Range } from "./a1.js";
import type { NameRec, SheetModel, WorkbookState } from "./model.js";
import { invalidateGraph, sheetOf } from "./state.js";
import { insertInOrder, kid, kids, qualify, setChildren } from "./xml-util.js";

export const WORKBOOK_ORDER = [
  "fileVersion",
  "fileSharing",
  "workbookPr",
  "workbookProtection",
  "bookViews",
  "sheets",
  "functionGroups",
  "externalReferences",
  "definedNames",
  "calcPr",
  "oleSize",
  "customWorkbookViews",
  "pivotCaches",
  "smartTagPr",
  "smartTagTypes",
  "webPublishing",
  "fileRecoveryPr",
  "webPublishObjects",
  "extLst",
];

/** Most defined names a workbook may hold through this handle. */
const MAX_NAMES = 10_000;
const MAX_REFERS_TO = 8192;

export function readNames(root: XmlElement, sheets: readonly SheetModel[]): NameRec[] {
  const container = kid(root, "definedNames");
  if (container === null) return [];
  const names: NameRec[] = [];
  for (const el of kids(container, "definedName")) {
    const name = getAttr(el, "name");
    if (name === null) continue;
    const local = getAttr(el, "localSheetId");
    const text = textContent(el);
    names.push({
      name,
      refersTo: text.startsWith("=") ? text.slice(1) : text,
      scope: local === null ? null : (sheets[Number(local)] ?? null),
      el,
    });
  }
  return names;
}

export function listNames(state: WorkbookState): DefinedName[] {
  return state.names.map((name) => ({
    name: name.name,
    refersTo: name.refersTo,
    scope: name.scope === null ? null : name.scope.id,
  }));
}

function checkName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length < 1 || name.length > 255) {
    throw new OfficeError("invalid_argument", "a defined name has 1 to 255 characters");
  }
  if (!/^[\p{L}_\\][\p{L}\p{N}_.\\?]*$/u.test(name)) {
    throw new OfficeError("invalid_argument", "a defined name starts with a letter or _ and has no spaces");
  }
  const upper = name.toUpperCase();
  if (tryParseA1Range(name) !== null || upper === "TRUE" || upper === "FALSE" || /^[RC]$/.test(upper) || /^R\d*C\d*$/.test(upper)) {
    throw new OfficeError("invalid_argument", "a defined name cannot look like a cell reference or a boolean");
  }
}

function findName(state: WorkbookState, name: string, scope: SheetModel | null): number {
  const key = name.toLowerCase();
  return state.names.findIndex((entry) => entry.scope === scope && entry.name.toLowerCase() === key);
}

function touchNames(state: WorkbookState): void {
  state.namesDirty = true;
  state.calc.all = true;
  invalidateGraph(state);
}

export function setName(state: WorkbookState, definition: DefinedName): void {
  if (definition === null || typeof definition !== "object") throw new OfficeError("invalid_argument", "not a defined name");
  checkName(definition.name);
  const raw: unknown = definition.refersTo;
  if (typeof raw !== "string") throw new OfficeError("invalid_argument", "refersTo must be formula text");
  const refersTo = raw.startsWith("=") ? raw.slice(1) : raw;
  if (refersTo.trim() === "" || refersTo.length > MAX_REFERS_TO) {
    throw new OfficeError("invalid_argument", "refersTo is empty or too long");
  }
  const scope = definition.scope === null || definition.scope === undefined ? null : sheetOf(state, definition.scope);
  const at = findName(state, definition.name, scope);
  if (at >= 0) {
    const entry = state.names[at] as NameRec;
    entry.name = definition.name;
    entry.refersTo = refersTo;
  } else {
    if (state.names.length >= MAX_NAMES) throw new OfficeError("limit_exceeded", "too many defined names");
    state.names.push({ name: definition.name, refersTo, scope, el: null });
  }
  touchNames(state);
}

export function removeName(state: WorkbookState, name: string, scope: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const sheet = scope === null || scope === undefined ? null : sheetOf(state, scope);
  const at = findName(state, name, sheet);
  if (at < 0) return false;
  state.names.splice(at, 1);
  touchNames(state);
  return true;
}

/** The name as seen from a sheet: one local to the sheet wins over a workbook name. */
export function lookupName(state: WorkbookState, name: string, sheet: SheetModel | null): NameRec | null {
  const key = name.toLowerCase();
  let global: NameRec | null = null;
  for (const entry of state.names) {
    if (entry.name.toLowerCase() !== key) continue;
    if (entry.scope === sheet && sheet !== null) return entry;
    if (entry.scope === null) global = entry;
  }
  return global;
}

/** Writes the names into the workbook XML. */
export function flushNames(state: WorkbookState): void {
  if (!state.namesDirty) return;
  const root = state.workbookPart.doc.root;
  let container = kid(root, "definedNames");
  if (state.names.length === 0) {
    if (container !== null) remove(container);
  } else {
    if (container === null) {
      container = createElement(qualify(root, "definedNames"));
      insertInOrder(root, container, WORKBOOK_ORDER);
    }
    const elements: XmlElement[] = [];
    for (const name of state.names) {
      const el = name.el ?? (name.el = createElement(qualify(root, "definedName"), { name: name.name }));
      if (getAttr(el, "name") !== name.name) setAttr(el, "name", name.name);
      const local = name.scope === null ? null : String(state.sheets.indexOf(name.scope));
      if (getAttr(el, "localSheetId") !== local) {
        if (local === null) removeAttr(el, "localSheetId");
        else setAttr(el, "localSheetId", local);
      }
      const current = textContent(el);
      if (current !== name.refersTo && current !== `=${name.refersTo}`) setTextContent(el, name.refersTo);
      elements.push(el);
    }
    setChildren(container, elements);
  }
  state.namesDirty = false;
  state.workbookPart.dirty = true;
}
