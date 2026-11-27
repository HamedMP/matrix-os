/**
 * The features of other sheets that a deletion of rows or columns rewrites.
 *
 * Links, conditional formats and data validations on any sheet can name
 * cells of the sheet that loses rows or columns, and those references turn
 * into #REF!. Inserting the rows again does not bring them back, so the
 * change journal keeps, for every other sheet whose features the deletion
 * would rewrite, their markup before and after it, and puts the markup back
 * when the deletion is rejected and the sheet still holds what the deletion
 * left. The markup comes back from a saved file, so it is checked again
 * before it is used.
 */

import type { SheetId } from "../../api/xlsx.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { cloneNode, escapeXmlAttr, parseXml, remove, serializeXml } from "../../xml/index.js";
import { mayHoldFeatureFormulas, rewriteFeatureFormulasIn } from "./feature-formulas.js";
import { MAX_FEATURE_TEXT, featureElements } from "./features.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { type StructuralOp, rewriteForStructure } from "./refs-rewrite.js";
import { attachSheet } from "./sheet-read.js";
import { WORKSHEET_ORDER } from "./sheet-write.js";
import { sheetOf } from "./state.js";
import { insertInOrder } from "./xml-util.js";

/** JSON. The feature markup of one other sheet, in document order, before and after a deletion. */
export interface LinkedFeatures {
  sheet: SheetId;
  /** Namespace declarations of the worksheet element, needed to read the markup again. */
  ns: Array<[string, string]>;
  before: string[];
  after: string[];
}

/** Sheets one deletion may keep markup for. */
export const MAX_LINKED_SHEETS = 10_000;

function namespaces(root: XmlElement): Array<[string, string]> {
  const ns: Array<[string, string]> = [];
  for (const attr of root.attrs) if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) ns.push([attr.name, attr.value]);
  return ns;
}

function parseMarkup(ns: ReadonlyArray<readonly [string, string]>, elements: readonly string[]): XmlElement {
  const declarations = ns.map(([name, value]) => ` ${name}="${escapeXmlAttr(value)}"`).join("");
  return parseXml(`<worksheet${declarations}>${elements.join("")}</worksheet>`).root;
}

function tooMuch(): OfficeError {
  return new OfficeError("limit_exceeded", "the deletion rewrites too many links, formats and validations of other sheets to keep as a proposal", {
    details: { maxFeatureText: MAX_FEATURE_TEXT },
  });
}

/**
 * The markup of every other sheet whose features deleting the rows or columns of `op` (`count` below 0) from
 * `sheet` would rewrite, before and after. Reads only. Throws `limit_exceeded` when it is too large to keep.
 */
export function captureLinkedFeatures(state: WorkbookState, sheet: SheetModel, op: StructuralOp): LinkedFeatures[] {
  const key = sheet.name.toLowerCase();
  const found: LinkedFeatures[] = [];
  let size = 0;
  for (const other of state.sheets) {
    if (other === sheet || !mayHoldFeatureFormulas(other)) continue;
    const root = attachSheet(other).doc.root;
    const before = featureElements(root).map((element) => serializeXml(element));
    if (before.length === 0) continue;
    const ns = namespaces(root);
    const copy = parseMarkup(ns, before);
    if (!rewriteFeatureFormulasIn(copy, (text) => rewriteForStructure(text, false, key, op))) continue;
    const after = featureElements(copy).map((element) => serializeXml(element));
    for (const text of before) size += text.length;
    for (const text of after) size += text.length;
    if (size > MAX_FEATURE_TEXT || found.length >= MAX_LINKED_SHEETS) throw tooMuch();
    found.push({ sheet: other.id, ns, before, after });
  }
  return found;
}

/** True when the sheet's features are exactly the markup a deletion left: only then is the earlier markup put back. */
export function holdsLinkedFeatures(state: WorkbookState, linked: LinkedFeatures): boolean {
  if (!state.sheetsById.has(linked.sheet)) return false;
  const current = featureElements(attachSheet(sheetOf(state, linked.sheet)).doc.root);
  return current.length === linked.after.length && current.every((element, at) => serializeXml(element) === linked.after[at]);
}

/** False when kept markup read from a file cannot be used. */
export function readableLinkedFeatures(linked: LinkedFeatures): boolean {
  try {
    parseMarkup(linked.ns, linked.before);
    parseMarkup(linked.ns, linked.after);
    return true;
  } catch (error) {
    if (isOfficeError(error, "malformed_xml", "limit_exceeded")) return false;
    throw error;
  }
}

/** Puts the markup from before the deletion back. Call {@link readableLinkedFeatures} first. */
export function restoreLinkedFeatures(state: WorkbookState, linked: LinkedFeatures): void {
  const sheet = sheetOf(state, linked.sheet);
  const root = attachSheet(sheet).doc.root;
  const elements = featureElements(parseMarkup(linked.ns, linked.before));
  for (const element of featureElements(root)) remove(element);
  for (const element of elements) insertInOrder(root, cloneNode(element), WORKSHEET_ORDER);
  sheet.dirty = true;
}

/** Applies a formula rewrite (a rename, a removed sheet, moved rows) to the kept markup, before and after alike. */
export function rewriteLinkedFeatures(linked: LinkedFeatures, rewrite: (text: string) => string): LinkedFeatures {
  if (!readableLinkedFeatures(linked)) return linked;
  const apply = (elements: string[]): string[] => {
    const wrapper = parseMarkup(linked.ns, elements);
    return rewriteFeatureFormulasIn(wrapper, rewrite) ? featureElements(wrapper).map((element) => serializeXml(element)) : elements;
  };
  const before = apply(linked.before);
  const after = apply(linked.after);
  return before === linked.before && after === linked.after ? linked : { ...linked, before, after };
}
