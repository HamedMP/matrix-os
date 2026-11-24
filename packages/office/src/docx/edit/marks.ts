/**
 * Paragraph marks: the tracked-change state a mark carries in
 * `w:pPr/w:rPr`, the section break that rides on it, and what happens to
 * two paragraphs when the mark between them goes.
 */

import type { TextPosition } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { appendChild, insertBefore, remove } from "../../xml/index.js";
import type { BlockRecord, DocxIndex } from "../internal.js";
import { REVISION_CONTAINERS, firstChild, rowCells, tableRows } from "../internal.js";
import { PPR_ORDER, RPR_ORDER } from "./schema-order.js";
import { rescueAnchors } from "./anchors.js";
import type { PositionTracker } from "./tracker.js";
import { elementParent, ensureChild, ensureFirst, hasElementChildren, insertOrdered } from "./xml-util.js";

/** The tracked-change elements of a paragraph mark, in file order. */
export function markRevisions(paragraph: XmlElement): XmlElement[] {
  const pPr = firstChild(paragraph, "w:pPr");
  const rPr = pPr === null ? null : firstChild(pPr, "w:rPr");
  const found: XmlElement[] = [];
  if (rPr === null) return found;
  for (const node of rPr.children) if (node.kind === "element" && REVISION_CONTAINERS.has(node.name)) found.push(node);
  return found;
}

export function ensureParagraphProps(paragraph: XmlElement): XmlElement {
  return ensureFirst(paragraph, "w:pPr");
}

/** Puts a tracked-change element on the mark of a paragraph. */
export function addMarkRevision(paragraph: XmlElement, revision: XmlElement): void {
  const rPr = ensureChild(ensureParagraphProps(paragraph), "w:rPr", PPR_ORDER);
  insertOrdered(rPr, revision, RPR_ORDER);
}

/** Drops `w:pPr/w:rPr` and `w:pPr` when they hold nothing any more. */
export function pruneParagraphProps(paragraph: XmlElement): void {
  const pPr = firstChild(paragraph, "w:pPr");
  if (pPr === null) return;
  const rPr = firstChild(pPr, "w:rPr");
  if (rPr !== null && !hasElementChildren(rPr)) remove(rPr);
  if (!hasElementChildren(pPr)) remove(pPr);
}

/** Removes every tracked-change element from the mark of a paragraph. */
export function clearMarkRevisions(paragraph: XmlElement): void {
  for (const revision of markRevisions(paragraph)) remove(revision);
  pruneParagraphProps(paragraph);
}

export function sectionBreakOf(paragraph: XmlElement): XmlElement | null {
  const pPr = firstChild(paragraph, "w:pPr");
  return pPr === null ? null : firstChild(pPr, "w:sectPr");
}

/**
 * Hands the state of the mark of `from` to `to`: its tracked-change
 * elements and its section break. What `to` carried before is dropped. The
 * elements themselves move, so their revision and block ids move with them.
 */
export function moveMarkState(from: XmlElement, to: XmlElement): void {
  for (const revision of markRevisions(to)) remove(revision);
  const stale = sectionBreakOf(to);
  if (stale !== null) remove(stale);
  for (const revision of markRevisions(from)) addMarkRevision(to, revision);
  const sectPr = sectionBreakOf(from);
  if (sectPr !== null) insertOrdered(ensureParagraphProps(to), sectPr, PPR_ORDER);
  pruneParagraphProps(from);
  pruneParagraphProps(to);
}

/** Children of a paragraph other than its properties. */
export function contentNodes(paragraph: XmlElement): XmlElement["children"][number][] {
  return paragraph.children.filter((node) => !(node.kind === "element" && node.name === "w:pPr"));
}

export interface MergeOptions {
  /**
   * `first`: the first paragraph always survives. `auto`: the first
   * survives unless it is empty, so that a paragraph that only held removed
   * text disappears without touching its neighbour: the paragraph after it
   * keeps its own properties, also when that one is empty too.
   */
  readonly survivor: "first" | "auto";
  readonly tracker?: PositionTracker;
}

/**
 * Joins two sibling paragraphs after the mark of the first went. The
 * survivor keeps its element, block id and properties; the mark that ends
 * the joined paragraph is the mark of `second`, with its tracked-change
 * state and section break. Returns the survivor.
 */
export function mergeParagraphs(index: DocxIndex, first: XmlElement, second: XmlElement, options: MergeOptions): XmlElement {
  const firstRecord = index.blockOf(first);
  const secondRecord = index.blockOf(second);
  const firstLength = index.scan(first).text.length;
  const secondLength = index.scan(second).text.length;
  const firstParent = elementParent(first);
  const secondParent = elementParent(second);
  const keepFirst = options.survivor === "first" || firstLength > 0;
  if (keepFirst) {
    moveMarkState(second, first);
    for (const node of contentNodes(second)) appendChild(first, node);
    remove(second);
    if (firstRecord !== null && secondRecord !== null) {
      options.tracker?.textMoved(secondRecord.id, 0, firstRecord.id, firstLength);
    }
    index.markDirty(first);
    if (secondParent !== null) index.markDirty(secondParent);
    return first;
  }
  // The first paragraph holds no text: what is left in it (bookmarks, comment anchors) moves to the front of the second.
  const anchor = contentNodes(second)[0] ?? null;
  for (const node of contentNodes(first)) {
    if (anchor === null) appendChild(second, node);
    else insertBefore(anchor, node);
  }
  remove(first);
  if (firstRecord !== null && secondRecord !== null) {
    options.tracker?.textMoved(firstRecord.id, 0, secondRecord.id, 0);
  }
  index.markDirty(second);
  if (firstParent !== null) index.markDirty(firstParent);
  return second;
}

/** Sibling blocks of a block that hold content: paragraphs and tables, without section break records. */
export function contentSiblings(index: DocxIndex, record: BlockRecord): BlockRecord[] {
  return index.blocksIn(record.container).filter((entry) => entry.type !== "sectionBreak");
}

export function nextContentBlock(index: DocxIndex, record: BlockRecord): BlockRecord | null {
  const siblings = contentSiblings(index, record);
  return siblings[siblings.findIndex((entry) => entry.id === record.id) + 1] ?? null;
}

export function previousContentBlock(index: DocxIndex, record: BlockRecord): BlockRecord | null {
  const siblings = contentSiblings(index, record);
  const at = siblings.findIndex((entry) => entry.id === record.id);
  return at <= 0 ? null : (siblings[at - 1] ?? null);
}

/** The first text position inside a block: its own start, or the start of the first paragraph of a table. */
export function firstPositionIn(index: DocxIndex, record: BlockRecord): TextPosition | null {
  if (record.type === "paragraph") return { blockId: record.id, offset: 0 };
  if (record.type !== "table") return null;
  for (const row of tableRows(record.element)) {
    for (const cell of rowCells(row)) {
      for (const inner of index.blocksIn(cell)) {
        const position = firstPositionIn(index, inner);
        if (position !== null) return position;
      }
    }
  }
  return null;
}

/** The last text position inside a block. */
export function lastPositionIn(index: DocxIndex, record: BlockRecord): TextPosition | null {
  if (record.type === "paragraph") return { blockId: record.id, offset: index.scan(record.element).text.length };
  if (record.type !== "table") return null;
  const rows = tableRows(record.element);
  for (let r = rows.length - 1; r >= 0; r--) {
    const cells = rowCells(rows[r] as XmlElement);
    for (let c = cells.length - 1; c >= 0; c--) {
      const blocks = index.blocksIn(cells[c] as XmlElement);
      for (let b = blocks.length - 1; b >= 0; b--) {
        const position = lastPositionIn(index, blocks[b] as BlockRecord);
        if (position !== null) return position;
      }
    }
  }
  return null;
}

/** The nearest position that survives when `record` is removed: the start of what follows, else the end of what precedes. */
export function fallbackPosition(index: DocxIndex, record: BlockRecord): TextPosition | null {
  const next = nextContentBlock(index, record);
  const after = next === null ? null : firstPositionIn(index, next);
  if (after !== null) return after;
  const previous = previousContentBlock(index, record);
  return previous === null ? null : lastPositionIn(index, previous);
}

/**
 * Removes a block element from its story. The caller has checked that the
 * container keeps a paragraph. Positions in it move to the nearest survivor.
 */
export function removeBlock(index: DocxIndex, record: BlockRecord, tracker?: PositionTracker): void {
  const fallback = fallbackPosition(index, record);
  const ids: string[] = [];
  const collect = (entry: BlockRecord): void => {
    ids.push(entry.id);
    if (entry.type !== "table") return;
    for (const row of tableRows(entry.element)) {
      for (const cell of rowCells(row)) for (const inner of index.blocksIn(cell)) collect(inner);
    }
  };
  collect(record);
  const parent = elementParent(record.element);
  // Bookmarks, comment anchors and open fields in the block move to the nearest paragraph that stays.
  const rescued = rescueAnchors(record.element);
  if (rescued !== null) index.markDirty(rescued);
  remove(record.element);
  if (tracker !== undefined) for (const id of ids) tracker.blockRemoved(id, fallback);
  if (parent !== null) index.markDirty(parent);
}
