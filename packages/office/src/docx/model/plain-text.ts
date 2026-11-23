/**
 * Plain text of blocks, stories and ranges in a view of the tracked changes.
 *
 * Paragraphs end with `\n`; a paragraph whose mark is gone in the view (a
 * deleted mark in `final`, an inserted one in `original`) runs on into the
 * next paragraph. With no paragraph after it, it stays when it has content
 * in the view and is left out when it has none, as resolving the revision
 * removes it. Table cells are separated by `\t` and rows by `\n`; rows
 * and cells that are gone in the view are left out (see
 * `table-revisions.ts`), and a table with no row left is not there for its
 * neighbours either. A mark, row or cell that one author inserted and
 * another deleted is gone in both views. Inline objects are left out.
 */

import type { DocxTextView, TextRange } from "../../api/docx-model.js";
import { OfficeError } from "../../errors.js";
import type { DocxIndex } from "./doc-index.js";
import { type ParagraphScan, atomInView, revisionsGoneInView } from "./inline.js";
import { type BlockRecord, rowCells, tableRows } from "./structure.js";
import { cellGoneInView, rowGoneInView, tableGoneInView } from "./table-revisions.js";

/** The text of a paragraph in a view between two markup offsets, without inline objects. */
export function paragraphText(scan: ParagraphScan, view: DocxTextView, from = 0, to = Number.POSITIVE_INFINITY): string {
  let text = "";
  for (const atom of scan.atoms) {
    const end = atom.start + atom.text.length;
    if (end <= from) continue;
    if (atom.start >= to) break;
    if (atom.kind === "object" || !atomInView(atom, view)) continue;
    text += atom.text.slice(Math.max(0, from - atom.start), Math.min(atom.text.length, to - atom.start));
  }
  return text;
}

function stripLastNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function tableText(index: DocxIndex, record: BlockRecord, view: DocxTextView): string {
  let text = "";
  for (const row of tableRows(record.element)) {
    if (rowGoneInView(row, view)) continue;
    const cells: string[] = [];
    for (const cell of rowCells(row)) {
      if (!cellGoneInView(cell, view)) cells.push(stripLastNewline(blocksText(index, index.blocksIn(cell), view)));
    }
    text += `${cells.join("\t")}\n`;
  }
  return text;
}

/** True when the paragraph shows something in the view: text or an inline object. */
function hasContentInView(scan: ParagraphScan, view: DocxTextView): boolean {
  for (const atom of scan.atoms) if (atomInView(atom, view)) return true;
  return false;
}

/**
 * Whether a paragraph without a mark and without content goes when its
 * revision is resolved: it does before a table and at the end of its
 * container after another paragraph, and it stays when it carries a section
 * break (the next record) or is all its container has.
 */
export function emptyParagraphGoes(next: { type: string } | undefined, previous: { type: string } | undefined): boolean {
  if (next === undefined) return previous !== undefined && previous.type === "paragraph";
  return next.type === "table";
}

/** Plain text of a list of sibling blocks. */
export function blocksText(index: DocxIndex, blocks: readonly BlockRecord[], view: DocxTextView): string {
  // A table that is gone in the view is gone for the paragraphs around it too.
  const records = view === "markup" ? blocks : blocks.filter((record) => !(record.type === "table" && tableGoneInView(record.element, view)));
  let text = "";
  /** True while the paragraph being written, with those that ran on into it, shows something. */
  let content = false;
  for (let position = 0; position < records.length; position++) {
    const record = records[position] as BlockRecord;
    if (record.type === "table") {
      text += tableText(index, record, view);
      content = false;
    } else if (record.type === "paragraph") {
      const scan = index.scan(record.element);
      text += paragraphText(scan, view);
      content ||= hasContentInView(scan, view);
      const next = records[position + 1];
      const gone = revisionsGoneInView(scan.marks, view);
      if (gone && next !== undefined && next.type === "paragraph") continue;
      if (!(gone && !content && emptyParagraphGoes(next, records[position - 1]))) text += "\n";
      content = false;
    }
  }
  return text;
}

/**
 * Plain text of a range. The ends must be valid positions in the same
 * paragraph or in sibling paragraphs (`stale_reference`, `invalid_argument`).
 */
export function rangeText(index: DocxIndex, range: TextRange, view: DocxTextView): string {
  const start = index.requireBlock(range.start.blockId, "paragraph");
  const end = index.requireBlock(range.end.blockId, "paragraph");
  const startScan = index.scan(start.element);
  const endScan = index.scan(end.element);
  const valid = (offset: number, scan: ParagraphScan): boolean =>
    Number.isInteger(offset) && offset >= 0 && offset <= scan.text.length;
  if (!valid(range.start.offset, startScan) || !valid(range.end.offset, endScan)) {
    throw new OfficeError("stale_reference", "range offset is outside the paragraph text");
  }
  if (start === end) {
    if (range.start.offset > range.end.offset) throw new OfficeError("invalid_argument", "range start is after its end");
    return paragraphText(startScan, view, range.start.offset, range.end.offset);
  }
  if (start.container !== end.container || start.indexInContainer > end.indexInContainer) {
    throw new OfficeError("invalid_argument", "range ends must be in order and in sibling paragraphs");
  }
  const siblings = index.blocksIn(start.container);
  let text = paragraphText(startScan, view, range.start.offset);
  const firstNext = siblings[start.indexInContainer + 1];
  if (!(revisionsGoneInView(startScan.marks, view) && firstNext !== undefined && firstNext.type === "paragraph")) text += "\n";
  text += blocksText(index, siblings.slice(start.indexInContainer + 1, end.indexInContainer), view);
  // `blocksText` cannot see that the last block before the end paragraph is followed by a paragraph.
  const before = siblings[end.indexInContainer - 1];
  if (
    before !== undefined &&
    before !== start &&
    before.type === "paragraph" &&
    revisionsGoneInView(index.scan(before.element).marks, view) &&
    text.endsWith("\n")
  ) {
    text = text.slice(0, -1);
  }
  return text + paragraphText(endScan, view, 0, range.end.offset);
}
