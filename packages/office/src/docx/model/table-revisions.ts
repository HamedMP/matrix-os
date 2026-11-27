/**
 * The tracked changes of table rows and cells: where the file keeps them
 * and what a view of the document shows of them.
 *
 * A row carries `w:ins` and `w:del` in its `w:trPr`; a cell carries
 * `w:cellIns` and `w:cellDel` in its `w:tcPr`, which is how a tracked column
 * insertion or deletion is written. Either can carry both, when one author
 * inserted what another then deleted. A deletion is gone in the `final`
 * view and an insertion in the `original` view, as resolving them leaves the
 * table: a row whose cells are all gone is gone with them, and so is a table
 * with no row left.
 */

import type { DocxTextView } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { revisionsGoneInView, shownRevision } from "./inline.js";
import { firstChild } from "./names.js";
import { rowCells, tableRows } from "./structure.js";

const NONE: readonly XmlElement[] = Object.freeze([]);

function marksIn(properties: XmlElement | null, insertion: string, deletion: string): readonly XmlElement[] {
  if (properties === null) return NONE;
  let found: XmlElement[] | null = null;
  for (const node of properties.children) {
    if (node.kind === "element" && (node.name === insertion || node.name === deletion)) (found ??= []).push(node);
  }
  return found ?? NONE;
}

/** Every `w:ins` and `w:del` in the `w:trPr` of a row, in file order: a row one author inserted and another deleted has both. */
export function rowRevisionElements(row: XmlElement): readonly XmlElement[] {
  return marksIn(firstChild(row, "w:trPr"), "w:ins", "w:del");
}

/** The revision of a row a reader is shown: its `w:del`, else its `w:ins`, or null. */
export function rowRevisionElement(row: XmlElement): XmlElement | null {
  return shownRevision(rowRevisionElements(row));
}

/** Every `w:cellIns` and `w:cellDel` in the `w:tcPr` of a cell, in file order. */
export function cellRevisionElements(cell: XmlElement): readonly XmlElement[] {
  return marksIn(firstChild(cell, "w:tcPr"), "w:cellIns", "w:cellDel");
}

/** True when a table cell is not part of the view: deleted in `final`, inserted in `original`. */
export function cellGoneInView(cell: XmlElement, view: DocxTextView): boolean {
  if (view === "markup") return false;
  for (const mark of cellRevisionElements(cell)) if ((mark.name === "w:cellDel") === (view === "final")) return true;
  return false;
}

/** True when a table row is not part of the view: the row itself is gone, or every cell it has. */
export function rowGoneInView(row: XmlElement, view: DocxTextView): boolean {
  if (view === "markup") return false;
  if (revisionsGoneInView(rowRevisionElements(row), view)) return true;
  const cells = rowCells(row);
  if (cells.length === 0) return false;
  for (const cell of cells) if (!cellGoneInView(cell, view)) return false;
  return true;
}

/** True when a table has no row left in the view: resolving the revisions removes the table. */
export function tableGoneInView(table: XmlElement, view: DocxTextView): boolean {
  if (view === "markup") return false;
  const rows = tableRows(table);
  if (rows.length === 0) return false;
  for (const row of rows) if (!rowGoneInView(row, view)) return false;
  return true;
}
