/**
 * Brings a private copy of a document to its accepted state, in place:
 * the comparison treats revisions pending in its inputs as accepted.
 *
 * Insertions and move destinations are unwrapped, deletions and move sources
 * are removed, deleted rows and deleted cells are removed (a row with no
 * cell left goes with its last cell), property change records and move
 * range markers are dropped. A paragraph whose mark is deleted joins the
 * paragraph that follows it.
 */

import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { appendChild, insertBefore, remove } from "../../xml/index.js";
import type { DocxIndex } from "../internal.js";
import { firstChild } from "../internal.js";

const REMOVED_CONTENT: ReadonlySet<string> = new Set(["w:del", "w:moveFrom"]);
const KEPT_CONTENT: ReadonlySet<string> = new Set(["w:ins", "w:moveTo"]);
/** Cell marks that leave the cell where it is once accepted; `w:cellDel` takes the cell away. */
const CELL_MARKS: ReadonlySet<string> = new Set(["w:cellIns", "w:cellMerge"]);
const RANGE_MARKER = /^w:(?:moveFrom|moveTo|customXmlIns|customXmlDel|customXmlMoveFrom|customXmlMoveTo)Range(?:Start|End)$/;
const PROPERTY_CHANGE = /^w:[A-Za-z]+Change$/;
const BLOCKS: ReadonlySet<string> = new Set(["w:p", "w:tbl", "w:sdt", "w:customXml"]);

interface Pending {
  /** Paragraphs whose mark was deleted, in document order. */
  readonly joins: XmlElement[];
  readonly rows: XmlElement[];
  /** Cells that were deleted. */
  readonly cells: XmlElement[];
  changed: boolean;
}

function elementParent(node: XmlChildNode): XmlElement | null {
  const parent = node.parent;
  return parent !== null && parent.kind === "element" ? parent : null;
}

/** The `w:p` whose mark `element` (in `w:pPr/w:rPr`) revises, or null. */
function markOwner(element: XmlElement): XmlElement | null {
  const rPr = elementParent(element);
  if (rPr === null || rPr.name !== "w:rPr") return null;
  const pPr = elementParent(rPr);
  if (pPr === null || pPr.name !== "w:pPr") return null;
  const paragraph = elementParent(pPr);
  return paragraph !== null && paragraph.name === "w:p" ? paragraph : null;
}

/** The `w:tr` whose `w:trPr` holds `element`, or null. */
function rowOwner(element: XmlElement): XmlElement | null {
  const trPr = elementParent(element);
  if (trPr === null || trPr.name !== "w:trPr") return null;
  const row = elementParent(trPr);
  return row !== null && row.name === "w:tr" ? row : null;
}

/** The `w:tc` whose `w:tcPr` holds `element`, or null. */
function cellOwner(element: XmlElement): XmlElement | null {
  const tcPr = elementParent(element);
  if (tcPr === null || tcPr.name !== "w:tcPr") return null;
  const cell = elementParent(tcPr);
  return cell !== null && cell.name === "w:tc" ? cell : null;
}

function resolve(parent: XmlElement, pending: Pending): void {
  for (const node of [...parent.children]) {
    if (node.kind !== "element") continue;
    const name = node.name;
    if (REMOVED_CONTENT.has(name)) {
      const paragraph = markOwner(node);
      const row = paragraph === null ? rowOwner(node) : null;
      if (paragraph !== null) pending.joins.push(paragraph);
      else if (row !== null) pending.rows.push(row);
      remove(node);
      pending.changed = true;
    } else if (KEPT_CONTENT.has(name)) {
      if (markOwner(node) === null && rowOwner(node) === null) {
        resolve(node, pending);
        for (const inner of [...node.children]) insertBefore(node, inner);
      }
      remove(node);
      pending.changed = true;
    } else if (name === "w:cellDel") {
      const cell = cellOwner(node);
      if (cell !== null) pending.cells.push(cell);
      remove(node);
      pending.changed = true;
    } else if (PROPERTY_CHANGE.test(name) || RANGE_MARKER.test(name) || CELL_MARKS.has(name)) {
      remove(node);
      pending.changed = true;
    } else {
      resolve(node, pending);
    }
  }
}

function siblingBlocks(parent: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  for (const node of parent.children) if (node.kind === "element" && BLOCKS.has(node.name)) found.push(node);
  return found;
}

/** Joins a paragraph whose mark is gone to the paragraph after it, which keeps its own properties. */
function joinWithNext(paragraph: XmlElement): void {
  const parent = elementParent(paragraph);
  if (parent === null) return;
  const pPr = firstChild(paragraph, "w:pPr");
  if (pPr !== null && firstChild(pPr, "w:sectPr") !== null) return;
  const blocks = siblingBlocks(parent);
  const next = blocks[blocks.indexOf(paragraph) + 1];
  const content = paragraph.children.filter((node) => !(node.kind === "element" && node.name === "w:pPr"));
  if (next !== undefined && next.name === "w:p") {
    const nextProperties = firstChild(next, "w:pPr");
    const anchor = next.children.find((node) => node !== nextProperties) ?? null;
    for (const node of content) {
      if (anchor !== null) insertBefore(anchor, node);
      else appendChild(next, node);
    }
    remove(paragraph);
    return;
  }
  // No paragraph follows: an empty paragraph disappears unless it is the only block of its container.
  const empty = content.every((node) => node.kind !== "element");
  if (empty && blocks.length > 1) remove(paragraph);
}

/**
 * Accepts every pending revision of the document behind `index`. Returns
 * true when the document changed.
 */
export function acceptAllInPlace(index: DocxIndex): boolean {
  let changedAny = false;
  for (const slot of index.store.list()) {
    if (slot.kind !== "document" && slot.kind !== "header" && slot.kind !== "footer" && slot.kind !== "footnotes" && slot.kind !== "endnotes") {
      continue;
    }
    const pending: Pending = { joins: [], rows: [], cells: [], changed: false };
    resolve(slot.doc.root, pending);
    for (const cell of pending.cells) {
      const row = elementParent(cell);
      remove(cell);
      // A row cannot be left without a cell.
      if (row !== null && row.name === "w:tr" && firstChild(row, "w:tc") === null && !pending.rows.includes(row)) pending.rows.push(row);
    }
    for (const row of pending.rows) {
      const table = elementParent(row);
      remove(row);
      if (table !== null && table.name === "w:tbl" && firstChild(table, "w:tr") === null) remove(table);
    }
    for (let at = pending.joins.length - 1; at >= 0; at--) joinWithNext(pending.joins[at] as XmlElement);
    if (pending.changed) {
      index.markDirty(slot.doc.root);
      changedAny = true;
    }
  }
  return changedAny;
}
