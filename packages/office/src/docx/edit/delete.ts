/** Deleting text and paragraph marks, directly or as tracked deletions. */

import type { XmlElement } from "../../api/xml.js";
import { appendChild, createElement, insertBefore, prependChild, remove } from "../../xml/index.js";
import type { BlockRecord, InlineAtom } from "../internal.js";
import { splitRunAt } from "../internal.js";
import { type EditContext, type ResolvedRange, blockIdOf, isOwn, noteRevision, revisionAttrs, touch } from "./context.js";
import { hoistAnchorsBefore } from "./anchors.js";
import { codeRunsOfDeletedFields, runsInOrder } from "./fields.js";
import {
  addMarkRevision,
  markRevisions,
  mergeParagraphs,
  nextContentBlock,
  pruneParagraphProps,
  removeBlock,
  sectionBreakOf,
} from "./marks.js";
import { deleteRowsOf } from "./rows.js";
import { setRunDeleted } from "./text.js";
import { elementParent, nextElement, previousElement, removeEmptyWrappers } from "./xml-util.js";

interface Piece {
  /** The run, or the paragraph-level object, that goes. */
  readonly node: XmlElement;
  readonly start: number;
  length: number;
  readonly deleted: boolean;
  /** Enclosing insertion of the author of this edit, if any. */
  readonly ownInsertion: boolean;
}

function isOwnDeletion(context: EditContext, element: XmlElement | null): element is XmlElement {
  return element !== null && element.name === "w:del" && isOwn(context, element) && element.attrs.some((a) => a.name === "w:date" && a.value === context.date);
}

/** Wraps a run in a tracked deletion, joining a deletion of this edit next to it. */
function wrapDeleted(context: EditContext, node: XmlElement): void {
  setRunDeleted(node, true);
  const before = previousElement(node);
  if (isOwnDeletion(context, before)) {
    appendChild(before, node);
    noteRevision(context, before);
    return;
  }
  const after = nextElement(node);
  if (isOwnDeletion(context, after)) {
    prependChild(after, node);
    noteRevision(context, after);
    return;
  }
  const deletion = createElement("w:del", revisionAttrs(context));
  insertBefore(node, deletion);
  appendChild(deletion, node);
  noteRevision(context, deletion);
}

function removeNode(node: XmlElement): void {
  const parent = elementParent(node);
  // A comment reference or a range marker inside what goes stays; field characters go on purpose.
  hoistAnchorsBefore(node, node, { fields: false });
  remove(node);
  removeEmptyWrappers(parent);
}

/**
 * Deletes the text of a paragraph between two markup offsets.
 *
 * Tracked: the text stays, wrapped in `w:del`; text that is a pending
 * insertion of the same author is removed outright; text that is already
 * deleted is left as it is.
 */
export function deleteInParagraph(context: EditContext, paragraph: XmlElement, from: number, to: number): void {
  if (to <= from) return;
  const { index } = context;
  const blockId = blockIdOf(context, paragraph);
  splitRunAt(index, { blockId, offset: to });
  splitRunAt(index, { blockId, offset: from });
  const scan = index.scan(paragraph);
  const pieces: Piece[] = [];
  const byNode = new Map<XmlElement, Piece>();
  for (const atom of scan.atoms as readonly InlineAtom[]) {
    if (atom.start < from || atom.start >= to) continue;
    const node = atom.run ?? atom.node;
    const known = byNode.get(node);
    if (known !== undefined) {
      known.length += atom.text.length;
      continue;
    }
    const piece: Piece = {
      node,
      start: atom.start,
      length: atom.text.length,
      deleted: atom.context.deleted,
      ownInsertion: atom.context.revisions.some((revision) => revision.name === "w:ins" && isOwn(context, revision)),
    };
    byNode.set(node, piece);
    pieces.push(piece);
  }
  if (pieces.length === 0) return;

  // Code runs of fields that go as a whole take the fate of the result run that follows them.
  const codeRuns = codeRunsOfDeletedFields(scan, from, to);
  if (codeRuns.length > 0) {
    const order = runsInOrder(paragraph);
    for (const run of codeRuns) {
      const at = order.indexOf(run);
      let model: Piece | null = null;
      for (let next = at + 1; next < order.length && model === null; next++) model = byNode.get(order[next] as XmlElement) ?? null;
      for (let previous = at - 1; previous >= 0 && model === null; previous--) model = byNode.get(order[previous] as XmlElement) ?? null;
      if (model === null) continue;
      const piece: Piece = { node: run, start: model.start, length: 0, deleted: model.deleted, ownInsertion: model.ownInsertion };
      byNode.set(run, piece);
      pieces.push(piece);
    }
    const position = new Map(order.map((run, at) => [run, at] as const));
    pieces.sort((a, b) => a.start - b.start || (position.get(a.node) ?? 0) - (position.get(b.node) ?? 0));
  }

  if (!context.track) {
    for (const piece of pieces) removeNode(piece.node);
    context.tracker.textRemoved(blockId, from, to - from);
    touch(context, paragraph);
    return;
  }
  // From the end, so that the offsets of the pieces still to come stay true.
  for (let at = pieces.length - 1; at >= 0; at--) {
    const piece = pieces[at] as Piece;
    if (piece.deleted) continue;
    if (piece.ownInsertion) {
      removeNode(piece.node);
      context.tracker.textRemoved(blockId, piece.start, piece.length);
    } else {
      wrapDeleted(context, piece.node);
    }
  }
  touch(context, paragraph);
}

/**
 * Deletes the mark of a paragraph as a tracked change. A mark that is a
 * pending insertion of the same author is taken back: the paragraph joins
 * the next one. A mark that is already deleted stays as it is.
 */
export function deleteMarkTracked(context: EditContext, record: BlockRecord): void {
  const { index } = context;
  const paragraph = record.element;
  const marks = markRevisions(paragraph);
  if (marks.some((mark) => mark.name === "w:del" || mark.name === "w:moveFrom")) return;
  const own = marks.find((mark) => mark.name === "w:ins" && isOwn(context, mark));
  if (own === undefined) {
    const deletion = createElement("w:del", revisionAttrs(context));
    addMarkRevision(paragraph, deletion);
    noteRevision(context, deletion);
    touch(context, paragraph);
    return;
  }
  const next = nextContentBlock(index, record);
  if (next !== null && next.type === "paragraph") {
    remove(own);
    pruneParagraphProps(paragraph);
    const survivor = mergeParagraphs(index, paragraph, next.element, { survivor: "auto", tracker: context.tracker });
    context.touched.add(survivor);
    return;
  }
  // No paragraph to join: an inserted paragraph that is empty by now is simply taken back.
  if (index.scan(paragraph).text.length === 0 && next !== null && sectionBreakOf(paragraph) === null) {
    removeBlock(index, record, context.tracker);
  }
}

/** Deletes a range that was validated by `resolveRange`. */
export function deleteRange(context: EditContext, range: ResolvedRange): void {
  const { index } = context;
  const first = range.start.record;
  if (range.single) {
    deleteInParagraph(context, first.element, range.start.offset, range.end.offset);
    return;
  }
  const last = range.end.record;
  const siblings = index.blocksIn(first.container);
  const between = siblings
    .slice(first.indexInContainer + 1, last.indexInContainer)
    .filter((record) => record.type !== "sectionBreak")
    .map((record) => record.element);
  const firstElement = first.element;
  const lastElement = last.element;

  deleteInParagraph(context, lastElement, 0, range.end.offset);
  if (!context.track) {
    for (const element of between) {
      const record = index.blockOf(element);
      if (record !== null) removeBlock(index, record, context.tracker);
    }
    deleteInParagraph(context, firstElement, range.start.offset, index.scan(firstElement).text.length);
    const survivor = mergeParagraphs(index, firstElement, lastElement, { survivor: "first", tracker: context.tracker });
    context.touched.add(survivor);
    return;
  }
  for (let at = between.length - 1; at >= 0; at--) {
    const element = between[at] as XmlElement;
    const record = index.blockOf(element);
    if (record === null) continue;
    if (record.type === "table") {
      deleteRowsOf(context, record);
      continue;
    }
    deleteInParagraph(context, element, 0, index.scan(element).text.length);
    const current = index.blockOf(element);
    if (current !== null) deleteMarkTracked(context, current);
  }
  deleteInParagraph(context, firstElement, range.start.offset, index.scan(firstElement).text.length);
  const current = index.blockOf(firstElement);
  if (current !== null) deleteMarkTracked(context, current);
}
