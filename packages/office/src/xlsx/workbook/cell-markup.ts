/**
 * What the `<c>` element of a cell holds that the cell model does not: rich
 * text, cell and value metadata (`cm`, `vm`), the phonetic flag, extensions
 * and attributes of other software. The change journal keeps it for a
 * cell a proposal edits and for the cells of rows or columns a proposal
 * deletes, so that rejecting the proposal gives the cells back as they were
 * and not only their values.
 */

import type { CellValue } from "../../api/xlsx.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { isOfficeError } from "../../errors.js";
import { cloneNode, createElement, getAttr, parseXml, remove, removeAttr, serializeXml, setAttr, textContent } from "../../xml/index.js";
import { type CellRec, DIRTY_CONTENT, DIRTY_EDIT, DIRTY_STYLE, type RowRec } from "./model.js";
import { type SharedStrings, isPlainItem, stringItemText } from "./shared-strings.js";
import { isNamed, kid, localOf, qualify } from "./xml-util.js";

/** What {@link cellMarkup} reads of a cell: its element and flags, and the content the element was written for. */
export interface MarkupSource {
  el: CellRec["el"];
  dirty: number;
  value: CellValue;
  formula: string | null;
}

/** Attributes the model writes itself. */
const MODEL_ATTRS: ReadonlySet<string> = new Set(["r", "s", "t"]);
/** Attributes that describe the content; an edit that replaced the content drops them. */
const CONTENT_ATTRS: ReadonlySet<string> = new Set(["cm", "vm"]);
/** Children the model writes itself. */
const MODEL_CHILDREN = ["f", "v", "is"];

/** The rich text of a literal string cell as an inline `<is>`, or null when its text is plain. */
function richText(strings: SharedStrings, cell: MarkupSource, el: XmlElement): XmlElement | null {
  if (cell.formula !== null || typeof cell.value !== "string") return null;
  const type = getAttr(el, "t");
  let item: XmlElement | null = null;
  if (type === "inlineStr") item = kid(el, "is");
  else if (type === "s") {
    const v = kid(el, "v");
    const index = v === null ? Number.NaN : Number(textContent(v));
    item = Number.isInteger(index) ? strings.richItem(index) : null;
  }
  if (item === null || isPlainItem(item) || stringItemText(item) !== cell.value) return null;
  return createElement(qualify(el, "is"), undefined, item.children.map((node) => cloneNode(node as XmlChildNode)));
}

/**
 * A detached `<c>` element with what the cell's element holds besides value,
 * formula and style, or null when it holds nothing more. Rich text from the
 * shared string table is kept as inline rich text.
 */
export function cellMarkup(strings: SharedStrings, cell: MarkupSource): XmlElement | null {
  const el = cell.el;
  if (el === null || typeof el === "number") return null;
  const edited = (cell.dirty & DIRTY_EDIT) !== 0;
  const attrs: Array<[string, string]> = [];
  for (const attr of el.attrs) {
    if (MODEL_ATTRS.has(attr.name) || (edited && CONTENT_ATTRS.has(attr.name))) continue;
    attrs.push([attr.name, attr.value]);
  }
  const children: XmlChildNode[] = [];
  const rich = edited ? null : richText(strings, cell, el);
  if (rich !== null) children.push(rich);
  for (const node of el.children) {
    if (node.kind === "element" && !MODEL_CHILDREN.some((name) => isNamed(node.name, name))) children.push(cloneNode(node));
  }
  if (attrs.length === 0 && children.length === 0) return null;
  return createElement(qualify(el, "c"), attrs, children);
}

/**
 * Gives a cell the markup {@link cellMarkup} took, once its value, formula
 * and style are back: the next write of the sheet builds its element from
 * the model and carries the markup over. Rich text is kept only while it
 * still spells the cell's text.
 */
export function applyCellMarkup(cell: CellRec, row: RowRec, markup: XmlElement): void {
  for (const name of MODEL_ATTRS) removeAttr(markup, name);
  const rich = kid(markup, "is");
  if (rich !== null && (cell.formula !== null || typeof cell.value !== "string" || stringItemText(rich) !== cell.value)) remove(rich);
  cell.el = markup;
  cell.dirty = (cell.dirty | DIRTY_CONTENT | DIRTY_STYLE) & ~DIRTY_EDIT;
  row.dirty = true;
}

function isDeclaration(name: string): boolean {
  return name === "xmlns" || name.startsWith("xmlns:");
}

/**
 * {@link cellMarkup} as text that reads back on its own: the namespace
 * declarations of the worksheet element `root` are written on it.
 */
export function cellMarkupText(strings: SharedStrings, root: XmlElement, cell: MarkupSource): string | null {
  const markup = cellMarkup(strings, cell);
  if (markup === null) return null;
  for (const attr of root.attrs) if (isDeclaration(attr.name) && getAttr(markup, attr.name) === null) setAttr(markup, attr.name, attr.value);
  return serializeXml(markup);
}

/**
 * Reads text {@link cellMarkupText} wrote, for a sheet whose worksheet
 * element is `root`: the declarations the worksheet makes itself are taken
 * off again. Null when the text is not one readable `<c>` element (a damaged
 * saved journal).
 */
export function parseCellMarkup(text: string, root: XmlElement): XmlElement | null {
  let markup: XmlElement;
  try {
    markup = parseXml(text).root;
  } catch (error) {
    if (isOfficeError(error, "malformed_xml", "limit_exceeded")) return null;
    throw error;
  }
  if (localOf(markup.name) !== "c") return null;
  for (const attr of root.attrs) if (isDeclaration(attr.name) && getAttr(markup, attr.name) === attr.value) removeAttr(markup, attr.name);
  return markup;
}
