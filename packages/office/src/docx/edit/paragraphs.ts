/** Paragraph-level edits: inserting, splitting and deleting whole paragraphs. */

import type { ParagraphStylePatch, TextPosition } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, cloneNode, createElement, insertAfter, insertBefore, remove } from "../../xml/index.js";
import type { BlockRecord, InsertionPoint, ResolvedPosition } from "../internal.js";
import { firstChild, liftToParagraph, splitRunAt } from "../internal.js";
import { type EditContext, isOwn, noteRevision, revisionAttrs, touch } from "./context.js";
import { deleteInParagraph, deleteMarkTracked } from "./delete.js";
import {
  addMarkRevision,
  ensureParagraphProps,
  markRevisions,
  moveMarkState,
  nextContentBlock,
  previousContentBlock,
  pruneParagraphProps,
  removeBlock,
  sectionBreakOf,
} from "./marks.js";
import { applyParagraphPatch } from "./paragraph-style.js";
import { PPR_ORDER } from "./schema-order.js";
import { copyRunProps, makeRun, paragraphAttrs, runPropsOf } from "./text.js";
import { hasElementChildren, insertOrdered, removeChildren, renumberRevisions } from "./xml-util.js";

const NOT_COPIED: ReadonlySet<string> = new Set(["w:sectPr", "w:pPrChange"]);

/** A copy of paragraph properties for a new paragraph: no section break, no tracked-change records. */
function copyParagraphProps(source: XmlElement | null): XmlElement | null {
  const pPr = source === null ? null : firstChild(source, "w:pPr");
  if (pPr === null) return null;
  const copy = cloneNode(pPr);
  removeChildren(copy, NOT_COPIED);
  const markProps = firstChild(copy, "w:rPr");
  if (markProps !== null) {
    const clean = copyRunProps(markProps);
    remove(markProps);
    if (clean !== null) insertOrdered(copy, clean, PPR_ORDER);
  }
  return hasElementChildren(copy) ? copy : null;
}

/** The run properties new text in a paragraph next to `reference` starts from. */
function textPropsNear(context: EditContext, reference: BlockRecord, paragraph: XmlElement, after: boolean): XmlElement | null {
  const pPr = firstChild(paragraph, "w:pPr");
  const markProps = pPr === null ? null : copyRunProps(firstChild(pPr, "w:rPr"));
  if (markProps !== null || reference.type !== "paragraph") return markProps;
  const atoms = context.index.scan(reference.element).atoms;
  return runPropsOf((after ? atoms[atoms.length - 1] : atoms[0])?.run ?? null);
}

/** Implements `insertParagraphAfter` and `insertParagraphBefore`. Returns the new paragraph. */
export function insertParagraph(
  context: EditContext,
  reference: BlockRecord,
  after: boolean,
  text: string,
  style: Partial<ParagraphStylePatch> | undefined,
): XmlElement {
  const { index } = context;
  if (reference.type === "sectionBreak") {
    throw new OfficeError("invalid_operation", "a paragraph cannot be placed next to a section break record", {
      details: { blockId: reference.id },
    });
  }
  const template = reference.type === "paragraph" ? reference.element : null;
  const paragraph = createElement("w:p", paragraphAttrs(index, template));
  const properties = copyParagraphProps(template);
  if (properties !== null) appendChild(paragraph, properties);
  if (style !== undefined) {
    applyParagraphPatch(index, ensureParagraphProps(paragraph), style);
    pruneParagraphProps(paragraph);
  }
  if (text.length > 0) {
    const run = makeRun(textPropsNear(context, reference, paragraph, after), text);
    if (context.track) {
      const insertion = createElement("w:ins", revisionAttrs(context), [run]);
      appendChild(paragraph, insertion);
      noteRevision(context, insertion);
    } else {
      appendChild(paragraph, run);
    }
  }
  if (after) insertAfter(reference.element, paragraph);
  else insertBefore(reference.element, paragraph);
  if (context.track) {
    const mark = createElement("w:ins", revisionAttrs(context));
    if (after && template !== null && sectionBreakOf(template) === null) {
      // The new mark is the one that now ends the reference paragraph; the mark it had ends the new paragraph.
      moveMarkState(template, paragraph);
      addMarkRevision(template, mark);
      touch(context, template);
    } else {
      addMarkRevision(paragraph, mark);
    }
    noteRevision(context, mark);
  }
  context.createdElements.push(paragraph);
  context.index.markDirty(paragraph);
  return paragraph;
}

/** Implements `splitParagraph`. Returns the new paragraph, which holds the text after the position. */
export function splitParagraph(context: EditContext, resolved: ResolvedPosition): XmlElement {
  const { index } = context;
  const paragraph = resolved.record.element;
  const position: TextPosition = { blockId: resolved.record.id, offset: resolved.offset };
  const boundary = splitRunAt(index, position);
  let point: InsertionPoint;
  if (boundary.before === null) {
    const first = paragraph.children.find((node) => !(node.kind === "element" && node.name === "w:pPr")) ?? null;
    point = { parent: paragraph, before: first };
  } else {
    point = liftToParagraph(index, boundary.beforeNext);
  }
  const created = createElement("w:p", paragraphAttrs(index, paragraph));
  const pPr = firstChild(paragraph, "w:pPr");
  if (pPr !== null) {
    const copy = cloneNode(pPr);
    renumberRevisions(index, copy);
    // The mark state and the section break move as they are; the copy must not hold a second set.
    removeChildren(copy, "w:sectPr");
    const markProps = firstChild(copy, "w:rPr");
    if (markProps !== null) {
      removeChildren(markProps, new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo"]));
      if (!hasElementChildren(markProps)) remove(markProps);
    }
    if (hasElementChildren(copy)) appendChild(created, copy);
  }
  if (point.before !== null) {
    const siblings = paragraph.children;
    for (const node of siblings.slice(siblings.indexOf(point.before))) appendChild(created, node);
  }
  insertAfter(paragraph, created);
  moveMarkState(paragraph, created);
  if (context.track) {
    const mark = createElement("w:ins", revisionAttrs(context));
    addMarkRevision(paragraph, mark);
    noteRevision(context, mark);
  }
  context.createdElements.push(created);
  touch(context, paragraph);
  index.markDirty(created);
  const record = index.blockOf(created);
  if (record !== null) context.tracker.textMoved(position.blockId, position.offset, record.id, 0);
  return created;
}

/**
 * Implements `deleteParagraph`. A paragraph that cannot go (the last block
 * of its container, or the one that carries a section break) only loses its
 * content.
 */
export function deleteParagraph(context: EditContext, record: BlockRecord): void {
  const { index } = context;
  const paragraph = record.element;
  const length = index.scan(paragraph).text.length;
  const next = nextContentBlock(index, record);
  const removable = next !== null && sectionBreakOf(paragraph) === null;
  if (!removable) {
    deleteInParagraph(context, paragraph, 0, length);
    return;
  }
  if (!context.track) {
    removeBlock(index, record, context.tracker);
    return;
  }
  deleteInParagraph(context, paragraph, 0, length);
  // When the mark before this paragraph is a pending insertion of the same author, taking that mark back undoes it.
  const previous = previousContentBlock(index, record);
  const ownBreak =
    previous !== null &&
    previous.type === "paragraph" &&
    markRevisions(paragraph).length === 0 &&
    markRevisions(previous.element).some((mark) => mark.name === "w:ins" && isOwn(context, mark));
  const target = ownBreak ? previous : index.blockOf(paragraph);
  if (target !== null) deleteMarkTracked(context, target);
}
