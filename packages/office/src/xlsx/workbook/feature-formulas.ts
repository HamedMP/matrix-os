/**
 * The formulas a worksheet keeps outside its cells: the conditions of
 * conditional formats, the sources and limits of data validations (also the
 * ones newer files keep in the extension list) and the targets of links
 * into the workbook. They name cells and sheets as cell formulas do, and are
 * rewritten with them when a sheet is renamed or removed or rows and columns
 * move.
 */

import type { XmlElement } from "../../api/xml.js";
import { getAttr, setAttr, setTextContent, textContent } from "../../xml/index.js";
import type { SheetModel } from "./model.js";
import { attachSheet } from "./sheet-read.js";
import { isNamed, kid, kids } from "./xml-util.js";

/** Cheap test on the text of a sheet that was not parsed again yet: without these words there is nothing to rewrite. */
const FEATURE_WORDS = /conditionalFormatting|dataValidation|hyperlink|extLst/;

/**
 * Sheets whose text was searched and holds none of the features. Nothing
 * adds such a feature to a sheet, so the answer stands and the text of a
 * large sheet is searched once, not at every rename or inserted row.
 */
const plain = new WeakSet<SheetModel>();

type Rewrite = (text: string) => string;

function rewriteText(element: XmlElement, rewrite: Rewrite): boolean {
  const text = textContent(element);
  if (text === "") return false;
  const next = rewrite(text);
  if (next === text) return false;
  setTextContent(element, next);
  return true;
}

/** Rewrites the `formula`, `formula1` and `formula2` elements below `element`. */
function rewriteFormulaElements(element: XmlElement, rewrite: Rewrite): boolean {
  let changed = false;
  for (const node of element.children) {
    if (node.kind !== "element") continue;
    if (isNamed(node.name, "formula") || isNamed(node.name, "formula1") || isNamed(node.name, "formula2")) {
      if (rewriteText(node, rewrite)) changed = true;
    } else if (rewriteFormulaElements(node, rewrite)) {
      changed = true;
    }
  }
  return changed;
}

/** Calls `visit` for every element below `element` with the prefixed local name, as `xm:f` and `xm:sqref` in an extension. */
export function forEachExtensionElement(element: XmlElement, local: string, visit: (found: XmlElement) => void): void {
  // Collected first: `visit` may take elements out of the tree.
  const found: XmlElement[] = [];
  const stack: XmlElement[] = [element];
  while (stack.length > 0) {
    const current = stack.pop() as XmlElement;
    for (const node of current.children) {
      if (node.kind !== "element") continue;
      if (node.name.includes(":") && isNamed(node.name, local)) found.push(node);
      else stack.push(node);
    }
  }
  for (const item of found) visit(item);
}

/** Rewrites every feature formula of a parsed worksheet. True when one changed. */
export function rewriteFeatureFormulasIn(root: XmlElement, rewrite: Rewrite): boolean {
  let changed = false;
  for (const format of kids(root, "conditionalFormatting")) if (rewriteFormulaElements(format, rewrite)) changed = true;
  const validations = kid(root, "dataValidations");
  if (validations !== null && rewriteFormulaElements(validations, rewrite)) changed = true;
  const links = kid(root, "hyperlinks");
  for (const link of links === null ? [] : kids(links, "hyperlink")) {
    const location = getAttr(link, "location");
    if (location === null || location === "") continue;
    const next = rewrite(location);
    if (next === location) continue;
    setAttr(link, "location", next);
    changed = true;
  }
  const extensions = kid(root, "extLst");
  if (extensions !== null) {
    forEachExtensionElement(extensions, "f", (formula) => {
      if (rewriteText(formula, rewrite)) changed = true;
    });
  }
  return changed;
}

/**
 * Rewrites the feature formulas of a sheet. A sheet whose text holds none of
 * the features is not parsed for it, and a sheet where nothing changes is
 * not written.
 */
export function rewriteFeatureFormulas(sheet: SheetModel, rewrite: Rewrite): void {
  if (plain.has(sheet)) return;
  if (sheet.doc === null && sheet.sourceText !== null && !FEATURE_WORDS.test(sheet.sourceText)) {
    plain.add(sheet);
    return;
  }
  if (rewriteFeatureFormulasIn(attachSheet(sheet).doc.root, rewrite)) sheet.dirty = true;
}
