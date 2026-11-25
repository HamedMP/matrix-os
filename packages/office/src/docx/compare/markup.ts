/**
 * Writers for the revision markup a comparison produces: content wrappers
 * (`w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`), paragraph mark revisions,
 * tracked table rows and move range markers.
 */

import type { XmlAttrInit, XmlChildNode, XmlElement } from "../../api/xml.js";
import { appendChild, createElement, insertAfter, insertBefore, prependChild, remove, replaceNode } from "../../xml/index.js";
import { REVISION_CONTAINERS, firstChild, rowCells, tableRows } from "../internal.js";
import { type Para, nodesInRange, parentOf } from "./runs.js";
import type { ContentKind, Stamp } from "./types.js";

/** Inline wrappers whose children are inline content of the paragraph. */
const INLINE_WRAPPERS: ReadonlySet<string> = new Set([
  "w:hyperlink",
  "w:fldSimple",
  "w:smartTag",
  "w:sdt",
  "w:sdtContent",
  "w:customXml",
  "w:dir",
  "w:bdo",
]);

/** Children of an inline container a revision wrapper can take. */
const WRAPPABLE: ReadonlySet<string> = new Set(["w:r", "m:oMath", "m:oMathPara"]);

function stampAttrs(stamp: Stamp): Array<readonly [string, string]> {
  return [
    ["w:id", stamp.nextId()],
    ["w:author", stamp.author],
    ["w:date", stamp.date],
  ];
}

/** A new, empty revision element of the given kind. */
export function revisionElement(kind: ContentKind, stamp: Stamp, children?: readonly XmlChildNode[]): XmlElement {
  return createElement(`w:${kind}`, stampAttrs(stamp), children);
}

function renamed(element: XmlElement, name: string): XmlElement {
  const attrs: XmlAttrInit = element.attrs.map((entry) => [entry.name, entry.value] as const);
  const copy = createElement(name, attrs);
  for (const node of [...element.children]) appendChild(copy, node);
  return copy;
}

/** Deleted text is `w:delText`, a deleted field code `w:delInstrText`. */
function toDeletedText(run: XmlElement): void {
  for (const node of [...run.children]) {
    if (node.kind !== "element") continue;
    if (node.name === "w:t") replaceNode(node, renamed(node, "w:delText"));
    else if (node.name === "w:instrText") replaceNode(node, renamed(node, "w:delInstrText"));
  }
}

function nextElement(node: XmlElement): XmlElement | null {
  const siblings = parentOf(node).children;
  for (let position = siblings.indexOf(node) + 1; position < siblings.length; position++) {
    const sibling = siblings[position] as XmlChildNode;
    if (sibling.kind === "element") return sibling;
    if (sibling.kind === "text" && sibling.value.trim() !== "") return null;
  }
  return null;
}

/**
 * Wraps attached nodes in revision elements, one per stretch of neighbouring
 * siblings. Returns the wrappers in document order.
 */
export function wrapNodes(nodes: readonly XmlElement[], kind: ContentKind, stamp: Stamp): XmlElement[] {
  const wrappers: XmlElement[] = [];
  let current: XmlElement | null = null;
  for (const node of nodes) {
    if (current === null || nextElement(current) !== node) {
      current = revisionElement(kind, stamp);
      insertBefore(node, current);
      wrappers.push(current);
    }
    appendChild(current, node);
    if (kind === "del" && node.name === "w:r") toDeletedText(node);
  }
  return wrappers;
}

/** Marks the text of `[start, end)` as one kind of revision. */
export function wrapRange(para: Para, start: number, end: number, kind: ContentKind, stamp: Stamp): XmlElement[] {
  return wrapNodes(nodesInRange(para, start, end, stamp), kind, stamp);
}

/** Every run of a paragraph, field code runs included, in document order. */
function allRuns(container: XmlElement, found: XmlElement[]): void {
  for (const node of container.children) {
    if (node.kind !== "element") continue;
    if (WRAPPABLE.has(node.name)) found.push(node);
    else if (INLINE_WRAPPERS.has(node.name)) allRuns(node, found);
  }
}

/** Marks the whole content of a paragraph as one kind of revision. */
export function wrapParagraphContent(paragraph: XmlElement, kind: ContentKind, stamp: Stamp): XmlElement[] {
  const runs: XmlElement[] = [];
  allRuns(paragraph, runs);
  return wrapNodes(runs, kind, stamp);
}

/** The `w:pPr` of a paragraph, created when missing. */
export function ensureParagraphProperties(paragraph: XmlElement): XmlElement {
  const existing = firstChild(paragraph, "w:pPr");
  if (existing !== null) return existing;
  const pPr = createElement("w:pPr");
  prependChild(paragraph, pPr);
  return pPr;
}

/** Tracks the paragraph mark: the paragraph break itself is inserted, deleted or moved. */
export function setParagraphMark(paragraph: XmlElement, kind: ContentKind, stamp: Stamp): void {
  const pPr = ensureParagraphProperties(paragraph);
  let rPr = firstChild(pPr, "w:rPr");
  if (rPr === null) {
    rPr = createElement("w:rPr");
    const after = firstChild(pPr, "w:sectPr") ?? firstChild(pPr, "w:pPrChange");
    if (after !== null) insertBefore(after, rPr);
    else appendChild(pPr, rPr);
  }
  for (const node of [...rPr.children]) {
    if (node.kind === "element" && REVISION_CONTAINERS.has(node.name)) remove(node);
  }
  prependChild(rPr, revisionElement(kind, stamp));
}

/** Tracks a whole table row as inserted or deleted. */
export function setRowMark(row: XmlElement, kind: "ins" | "del", stamp: Stamp): void {
  let trPr = firstChild(row, "w:trPr");
  if (trPr === null) {
    trPr = createElement("w:trPr");
    const exceptions = firstChild(row, "w:tblPrEx");
    if (exceptions !== null) insertAfter(exceptions, trPr);
    else prependChild(row, trPr);
  }
  const change = firstChild(trPr, "w:trPrChange");
  const mark = revisionElement(kind, stamp);
  if (change !== null) insertBefore(change, mark);
  else appendChild(trPr, mark);
}

/** Paragraphs of a cell or a row in document order, nested tables included. */
function paragraphsUnder(container: XmlElement, found: XmlElement[]): void {
  for (const node of container.children) {
    if (node.kind !== "element") continue;
    if (node.name === "w:p") found.push(node);
    else if (node.name !== "w:tcPr" && node.name !== "w:trPr" && node.name !== "w:tblPr" && node.name !== "w:tblGrid") {
      paragraphsUnder(node, found);
    }
  }
}

/**
 * Marks a row, the rows of the tables nested in it, and all their content as
 * inserted or deleted. Returns the number of rows marked.
 */
export function markRow(row: XmlElement, kind: "ins" | "del", stamp: Stamp): number {
  setRowMark(row, kind, stamp);
  let rows = 1;
  for (const cell of rowCells(row)) {
    const paragraphs: XmlElement[] = [];
    paragraphsUnder(cell, paragraphs);
    for (const paragraph of paragraphs) {
      wrapParagraphContent(paragraph, kind, stamp);
      setParagraphMark(paragraph, kind, stamp);
    }
    for (const node of cell.children) {
      if (node.kind === "element" && node.name === "w:tbl") rows += markNestedRows(node, kind, stamp);
    }
  }
  return rows;
}

function markNestedRows(table: XmlElement, kind: "ins" | "del", stamp: Stamp): number {
  let rows = 0;
  for (const row of tableRows(table)) {
    setRowMark(row, kind, stamp);
    rows += 1;
    for (const cell of rowCells(row)) {
      for (const node of cell.children) {
        if (node.kind === "element" && node.name === "w:tbl") rows += markNestedRows(node, kind, stamp);
      }
    }
  }
  return rows;
}

/**
 * Puts the range markers of a move around the wrappers that hold the moved
 * text of one paragraph. Both halves of a move carry the same `name`.
 */
export function addMoveRange(
  paragraph: XmlElement,
  wrappers: readonly XmlElement[],
  kind: "moveFrom" | "moveTo",
  name: string,
  stamp: Stamp,
): void {
  const id = stamp.nextId();
  const start = createElement(`w:${kind}RangeStart`, [
    ["w:id", id],
    ["w:name", name],
    ["w:author", stamp.author],
    ["w:date", stamp.date],
  ]);
  const end = createElement(`w:${kind}RangeEnd`, [["w:id", id]]);
  const first = wrappers[0];
  const last = wrappers[wrappers.length - 1];
  if (first === undefined || last === undefined) {
    appendChild(paragraph, start);
    appendChild(paragraph, end);
    return;
  }
  insertBefore(first, start);
  insertAfter(last, end);
}
