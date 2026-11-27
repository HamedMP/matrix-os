/** `setRunFormat` and `setParagraphStyle`, with their tracked formatting revisions. */

import type { ParagraphStylePatch, RunFormat } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { appendChild, cloneNode, createElement, remove, serializeXml } from "../../xml/index.js";
import type { BlockRecord, InlineAtom } from "../internal.js";
import { firstChild, rowCells, splitRunAt, tableRows } from "../internal.js";
import { type EditContext, type ResolvedRange, isOwn, noteRevision, revisionAttrs, touch } from "./context.js";
import { ensureParagraphProps, markRevisions, pruneParagraphProps } from "./marks.js";
import { applyParagraphPatch } from "./paragraph-style.js";
import { applyRunFormat, runResolverFor } from "./run-format.js";
import { PPR_ORDER, RPR_ORDER } from "./schema-order.js";
import { ensureFirst, hasElementChildren, insertOrdered, removeChildren } from "./xml-util.js";

function childrenXml(element: XmlElement | null, skip: ReadonlySet<string>): string {
  if (element === null) return "";
  let text = "";
  for (const node of element.children) {
    if (node.kind === "element" && !skip.has(node.name)) text += serializeXml(node);
  }
  return text;
}

const RUN_CHANGE: ReadonlySet<string> = new Set(["w:rPrChange"]);
const PARAGRAPH_KEPT: ReadonlySet<string> = new Set(["w:rPr", "w:sectPr", "w:pPrChange"]);

/** Formats the runs of one paragraph between two offsets. */
function formatInParagraph(context: EditContext, record: BlockRecord, from: number, to: number, format: Partial<RunFormat>): void {
  if (to <= from) return;
  const { index } = context;
  const paragraph = record.element;
  splitRunAt(index, { blockId: record.id, offset: to });
  splitRunAt(index, { blockId: record.id, offset: from });
  const resolve = runResolverFor(index, record);
  const seen = new Set<XmlElement>();
  let changed = false;
  for (const atom of index.scan(paragraph).atoms as readonly InlineAtom[]) {
    if (atom.start < from || atom.start >= to || atom.run === null || seen.has(atom.run)) continue;
    const run = atom.run;
    seen.add(run);
    if (context.track && atom.context.deleted) continue;
    const existing = firstChild(run, "w:rPr");
    const before = childrenXml(existing, RUN_CHANGE);
    const previous = existing === null ? createElement("w:rPr") : cloneNode(existing);
    const properties = ensureFirst(run, "w:rPr");
    applyRunFormat(properties, format, resolve);
    if (childrenXml(properties, RUN_CHANGE) === before) {
      if (!hasElementChildren(properties)) remove(properties);
      continue;
    }
    changed = true;
    const ownInsertion = atom.context.revisions.some((revision) => revision.name === "w:ins" && isOwn(context, revision));
    if (context.track && !ownInsertion) {
      const known = firstChild(properties, "w:rPrChange");
      if (known === null) {
        removeChildren(previous, RUN_CHANGE);
        const change = createElement("w:rPrChange", revisionAttrs(context), [previous]);
        insertOrdered(properties, change, RPR_ORDER);
        noteRevision(context, change);
      } else {
        noteRevision(context, known);
      }
    }
    if (!hasElementChildren(properties)) remove(properties);
  }
  if (changed) touch(context, paragraph);
}

/** Implements `setRunFormat` on a validated range. */
export function setRunFormat(context: EditContext, range: ResolvedRange, format: Partial<RunFormat>): void {
  const { index } = context;
  const first = range.start.record;
  if (range.single) {
    formatInParagraph(context, first, range.start.offset, range.end.offset, format);
    return;
  }
  const last = range.end.record;
  const paragraphs: BlockRecord[] = [];
  // Every paragraph between the ends, the ones in the cells of a table (and of tables inside it) too.
  const collect = (record: BlockRecord): void => {
    if (record.type === "paragraph") paragraphs.push(record);
    if (record.type !== "table") return;
    for (const tableRow of tableRows(record.element)) {
      for (const tableCell of rowCells(tableRow)) for (const inner of index.blocksIn(tableCell)) collect(inner);
    }
  };
  for (const record of index.blocksIn(first.container).slice(first.indexInContainer + 1, last.indexInContainer)) collect(record);
  formatInParagraph(context, last, 0, range.end.offset, format);
  for (let at = paragraphs.length - 1; at >= 0; at--) {
    const record = paragraphs[at] as BlockRecord;
    formatInParagraph(context, record, 0, index.scan(record.element).text.length, format);
  }
  formatInParagraph(context, first, range.start.offset, index.scan(first.element).text.length, format);
}

/** Implements `setParagraphStyle`. */
export function setParagraphStyle(context: EditContext, record: BlockRecord, style: Partial<ParagraphStylePatch>): void {
  const { index } = context;
  const paragraph = record.element;
  const existing = firstChild(paragraph, "w:pPr");
  const before = childrenXml(existing, PARAGRAPH_KEPT);
  const previous = createElement("w:pPr");
  if (existing !== null) {
    for (const node of existing.children) {
      if (node.kind === "element" && !PARAGRAPH_KEPT.has(node.name)) appendChild(previous, cloneNode(node));
    }
  }
  const properties = ensureParagraphProps(paragraph);
  try {
    applyParagraphPatch(index, properties, style);
  } finally {
    pruneParagraphProps(paragraph);
  }
  const current = firstChild(paragraph, "w:pPr");
  if (childrenXml(current, PARAGRAPH_KEPT) === before) return;
  const ownParagraph = markRevisions(paragraph).some((mark) => mark.name === "w:ins" && isOwn(context, mark));
  if (context.track && !ownParagraph && current !== null) {
    const known = firstChild(current, "w:pPrChange");
    if (known === null) {
      const change = createElement("w:pPrChange", revisionAttrs(context), [previous]);
      insertOrdered(current, change, PPR_ORDER);
      noteRevision(context, change);
    } else {
      noteRevision(context, known);
    }
  } else if (context.track && !ownParagraph && current === null) {
    // Every property was removed: the record of the old ones is all the element holds.
    const change = createElement("w:pPrChange", revisionAttrs(context), [previous]);
    appendChild(ensureParagraphProps(paragraph), change);
    noteRevision(context, change);
  }
  touch(context, paragraph);
}
