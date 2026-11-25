/** Table rows: removing them, marking them deleted, and building new ones. */

import type { BlockId, TextPosition } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { appendChild, cloneNode, createElement, remove } from "../../xml/index.js";
import type { BlockRecord, DocxIndex } from "../internal.js";
import { attr, firstChild, rowCells, rowRevisionElement, tableRows } from "../internal.js";
import { type EditContext, isOwn, noteRevision, revisionAttrs, touch } from "./context.js";
import { deleteInParagraph } from "./delete.js";
import { rescueAnchors } from "./anchors.js";
import { addMarkRevision, fallbackPosition, firstPositionIn, lastPositionIn, markRevisions, removeBlock } from "./marks.js";
import { PPR_ORDER, TRPR_ORDER } from "./schema-order.js";
import { copyRunProps, makeRun, paragraphAttrs, runPropsOf } from "./text.js";
import { elementParent, ensureFirst, insertOrdered, removeChildren, renumberRevisions } from "./xml-util.js";

function blockIdsIn(index: DocxIndex, row: XmlElement): BlockId[] {
  const ids: BlockId[] = [];
  const collect = (record: BlockRecord): void => {
    ids.push(record.id);
    if (record.type !== "table") return;
    for (const inner of tableRows(record.element)) {
      for (const cell of rowCells(inner)) for (const block of index.blocksIn(cell)) collect(block);
    }
  };
  for (const cell of rowCells(row)) for (const block of index.blocksIn(cell)) collect(block);
  return ids;
}

function edgePosition(index: DocxIndex, row: XmlElement | undefined, first: boolean): TextPosition | null {
  if (row === undefined) return null;
  const cells = rowCells(row);
  const ordered = first ? cells : [...cells].reverse();
  for (const cell of ordered) {
    const blocks = index.blocksIn(cell);
    const list = first ? blocks : [...blocks].reverse();
    for (const block of list) {
      const position = first ? firstPositionIn(index, block) : lastPositionIn(index, block);
      if (position !== null) return position;
    }
  }
  return null;
}

/** Takes a row out of its table; the table goes with its last row. */
export function removeRow(context: EditContext, table: BlockRecord, row: XmlElement): void {
  const { index } = context;
  const rows = tableRows(table.element);
  if (rows.length <= 1) {
    removeBlock(index, table, context.tracker);
    return;
  }
  const at = rows.indexOf(row);
  const fallback =
    edgePosition(index, rows[at + 1], true) ?? edgePosition(index, rows[at - 1], false) ?? fallbackPosition(index, table);
  const ids = blockIdsIn(index, row);
  const parent = elementParent(row);
  const rescued = rescueAnchors(row);
  if (rescued !== null) index.markDirty(rescued);
  remove(row);
  for (const id of ids) context.tracker.blockRemoved(id, fallback);
  context.touched.add(table.element);
  index.markDirty(parent ?? table.element);
}

/** Marks a row, and everything in its cells, as a tracked deletion. */
function markRowDeleted(context: EditContext, table: BlockRecord, row: XmlElement): void {
  const { index } = context;
  const properties = ensureFirst(row, "w:trPr", "w:tblPrEx");
  const deletion = createElement("w:del", revisionAttrs(context));
  insertOrdered(properties, deletion, TRPR_ORDER);
  noteRevision(context, deletion);
  for (const cell of rowCells(row)) {
    const elements = index.blocksIn(cell).map((record) => record.element);
    for (const element of elements) {
      const record = index.blockOf(element);
      if (record === null) continue;
      if (record.type === "table") {
        deleteRowsOf(context, record);
      } else if (record.type === "paragraph") {
        deleteInParagraph(context, element, 0, index.scan(element).text.length);
        if (markRevisions(element).length === 0) {
          const mark = createElement("w:del", revisionAttrs(context));
          addMarkRevision(element, mark);
          noteRevision(context, mark);
          touch(context, element);
        }
      }
    }
  }
  context.touched.add(table.element);
  index.markDirty(row);
}

/**
 * Deletes a row. Tracked: the row is marked; a row that is a pending
 * insertion of the same author is removed outright and one that is already
 * marked deleted stays as it is.
 */
export function deleteRow(context: EditContext, table: BlockRecord, row: XmlElement): void {
  if (!context.track) {
    removeRow(context, table, row);
    return;
  }
  const mark = rowRevisionElement(row);
  if (mark !== null && mark.name === "w:del") return;
  if (mark !== null && mark.name === "w:ins" && isOwn(context, mark)) removeRow(context, table, row);
  else markRowDeleted(context, table, row);
}

/** Deletes every row of a table (a table inside a deleted range). */
export function deleteRowsOf(context: EditContext, table: BlockRecord): void {
  const rows = tableRows(table.element);
  for (let at = rows.length - 1; at >= 0; at--) {
    const current = context.index.blockOf(table.element);
    if (current === null) return;
    deleteRow(context, current, rows[at] as XmlElement);
  }
}

const ROW_ONLY: ReadonlySet<string> = new Set(["w:ins", "w:del", "w:trPrChange", "w:tblHeader", "w:cnfStyle"]);
const CELL_ONLY: ReadonlySet<string> = new Set(["w:tcPrChange", "w:cellIns", "w:cellDel", "w:cellMerge", "w:cnfStyle"]);
const PARAGRAPH_ONLY: ReadonlySet<string> = new Set(["w:sectPr", "w:pPrChange", "w:cnfStyle"]);

/** True when a cell continues a vertical merge that started above. */
function continuesMerge(cell: XmlElement | undefined): boolean {
  const properties = cell === undefined ? null : firstChild(cell, "w:tcPr");
  const merge = properties === null ? null : firstChild(properties, "w:vMerge");
  if (merge === null) return false;
  const value = attr(merge, "w:val");
  return value === null || value === "continue";
}

export interface NewRow {
  readonly row: XmlElement;
  /** The paragraph of each cell, in order. */
  readonly paragraphs: XmlElement[];
}

/**
 * Builds a row with the cell structure and properties of `template`.
 * `below` is the row that will follow the new one, or null: a vertical merge
 * that runs through both is continued by the new cells.
 */
export function buildRow(
  context: EditContext,
  template: XmlElement,
  below: XmlElement | null,
  texts: readonly string[],
): NewRow {
  const { index } = context;
  const row = createElement("w:tr");
  const paragraphs: XmlElement[] = [];
  for (const name of ["w:tblPrEx", "w:trPr"]) {
    const source = firstChild(template, name);
    if (source === null) continue;
    const copy = cloneNode(source);
    renumberRevisions(index, copy);
    removeChildren(copy, name === "w:trPr" ? ROW_ONLY : new Set(["w:tblPrExChange"]));
    if (copy.children.some((node) => node.kind === "element")) appendChild(row, copy);
  }
  if (context.track) {
    const mark = createElement("w:ins", revisionAttrs(context));
    insertOrdered(ensureFirst(row, "w:trPr", "w:tblPrEx"), mark, TRPR_ORDER);
    noteRevision(context, mark);
  }
  const belowCells = below === null ? [] : rowCells(below);
  rowCells(template).forEach((source, at) => {
    const cell = createElement("w:tc");
    const sourceProps = firstChild(source, "w:tcPr");
    if (sourceProps !== null) {
      const properties = cloneNode(sourceProps);
      renumberRevisions(index, properties);
      removeChildren(properties, CELL_ONLY);
      const merge = firstChild(properties, "w:vMerge");
      if (merge !== null) {
        remove(merge);
        if (continuesMerge(belowCells[at])) insertOrdered(properties, createElement("w:vMerge"), TC_ORDER);
      }
      if (properties.children.some((node) => node.kind === "element")) appendChild(cell, properties);
    }
    const sourceParagraph = index.blocksIn(source).find((record) => record.type === "paragraph")?.element ?? null;
    const paragraph = createElement("w:p", paragraphAttrs(index, sourceParagraph));
    const sourcePPr = sourceParagraph === null ? null : firstChild(sourceParagraph, "w:pPr");
    let runProps: XmlElement | null = null;
    if (sourcePPr !== null) {
      const properties = cloneNode(sourcePPr);
      removeChildren(properties, PARAGRAPH_ONLY);
      const markProps = firstChild(properties, "w:rPr");
      if (markProps !== null) {
        const clean = copyRunProps(markProps);
        remove(markProps);
        if (clean !== null) {
          insertOrdered(properties, clean, PPR_ORDER);
          runProps = copyRunProps(clean);
        }
      }
      if (properties.children.some((node) => node.kind === "element")) appendChild(paragraph, properties);
    }
    if (runProps === null && sourceParagraph !== null) {
      runProps = runPropsOf(index.scan(sourceParagraph).atoms[0]?.run ?? null);
    }
    const text = texts[at] ?? "";
    if (context.track) {
      const mark = createElement("w:ins", revisionAttrs(context));
      addMarkRevision(paragraph, mark);
      noteRevision(context, mark);
    }
    if (text.length > 0) {
      const run = makeRun(runProps, text);
      if (context.track) {
        const insertion = createElement("w:ins", revisionAttrs(context), [run]);
        appendChild(paragraph, insertion);
        noteRevision(context, insertion);
      } else {
        appendChild(paragraph, run);
      }
    }
    appendChild(cell, paragraph);
    appendChild(row, cell);
    paragraphs.push(paragraph);
  });
  return { row, paragraphs };
}

/** `w:tcPr`: the properties that come before `w:vMerge`, then the rest. */
const TC_ORDER: readonly string[] = [
  "w:cnfStyle",
  "w:tcW",
  "w:gridSpan",
  "w:hMerge",
  "w:vMerge",
  "w:tcBorders",
  "w:shd",
  "w:noWrap",
  "w:tcMar",
  "w:textDirection",
  "w:tcFitText",
  "w:vAlign",
  "w:hideMark",
  "*",
  "w:cellIns",
  "w:cellDel",
  "w:cellMerge",
  "w:tcPrChange",
];
