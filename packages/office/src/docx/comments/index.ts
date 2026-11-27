/**
 * Comments: adding a thread to a range, replying and resolving.
 *
 * A comment is three things: the entry in `word/comments.xml`, the range
 * markers and the reference run in the story, and (for threading and the
 * done state) an entry in `word/commentsExtended.xml`. Comments are never
 * tracked changes.
 */

import type { CommentId } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, createElement, insertAfter, lookupNamespace, setAttr } from "../../xml/index.js";
import { type EditContext, type ResolvedRange, touch } from "../edit/context.js";
import { requireWritableText, textNodes } from "../edit/text.js";
import { elementParent, insertAt } from "../edit/xml-util.js";
import type { DocxIndex, TextPoint } from "../internal.js";
import { attr, closest, commentElements, expandChildren, listComments, splitRunAt } from "../internal.js";

const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const PARAGRAPHS: ReadonlySet<string> = new Set(["w:p"]);

/** Longest comment text accepted. */
const MAX_COMMENT_LENGTH = 100_000;

export function requireCommentText(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new OfficeError("invalid_argument", "comment text must be a string");
  if (value.length > MAX_COMMENT_LENGTH) throw new OfficeError("limit_exceeded", "comment text is too long");
  requireWritableText(value, "comment text");
}

function hasStyle(index: DocxIndex, styleId: string): boolean {
  return index.resolver.styles.has(styleId);
}

function referenceProps(index: DocxIndex): XmlElement[] {
  if (!hasStyle(index, "CommentReference")) return [];
  return [createElement("w:rPr", [], [createElement("w:rStyle", [["w:val", "CommentReference"]])])];
}

/** The `w:comments` root, with the `w14` prefix bound so that paragraphs can carry a `w14:paraId`. */
function commentsRoot(index: DocxIndex): XmlElement {
  const root = index.ensurePart("comments");
  if (lookupNamespace(root, "w14") === null) {
    setAttr(root, "xmlns:w14", W14);
    index.markDirty(root);
  }
  return root;
}

/** Writes the entry of a new comment and returns it. */
function writeComment(context: EditContext, id: CommentId, text: string): XmlElement {
  const { index } = context;
  const root = commentsRoot(index);
  const comment = createElement("w:comment", [
    ["w:id", id],
    ["w:author", context.author],
    ["w:date", context.date],
    ["w:initials", context.initials],
  ]);
  const styled = hasStyle(index, "CommentText");
  text.split("\n").forEach((line, at) => {
    const paragraph = createElement("w:p", [["w14:paraId", index.allocateParaId()]]);
    if (styled) appendChild(paragraph, createElement("w:pPr", [], [createElement("w:pStyle", [["w:val", "CommentText"]])]));
    if (at === 0) appendChild(paragraph, createElement("w:r", [], [...referenceProps(index), createElement("w:annotationRef")]));
    if (line.length > 0) appendChild(paragraph, createElement("w:r", [], textNodes(line)));
    appendChild(comment, paragraph);
  });
  appendChild(root, comment);
  index.markDirty(comment);
  return comment;
}

function referenceRun(index: DocxIndex, id: CommentId): XmlElement {
  return createElement("w:r", [], [...referenceProps(index), createElement("w:commentReference", [["w:id", id]])]);
}

/** The inline node directly in the paragraph that holds `node` (possibly `node` itself). */
function topInline(node: XmlElement): XmlElement {
  let scope = node;
  for (let depth = 0; depth < 64; depth++) {
    const parent = elementParent(scope);
    if (parent === null || parent.name === "w:p") break;
    scope = parent;
  }
  return scope;
}

/** Implements `addComment` on a validated range. */
export function addComment(context: EditContext, range: ResolvedRange, text: string): CommentId {
  const { index } = context;
  if (range.empty) throw new OfficeError("invalid_argument", "a comment needs a range that is not empty");
  // The comments part belongs to the main document: a header, a footer or a note cannot refer to it.
  if (index.story(range.start.record.storyId)?.kind !== "body") {
    throw new OfficeError("invalid_operation", "a comment can only be anchored in the body of the document");
  }
  const id = index.allocateCommentId();
  const endPosition = { blockId: range.end.record.id, offset: range.end.offset };
  const startPosition = { blockId: range.start.record.id, offset: range.start.offset };

  const endBoundary = splitRunAt(index, endPosition);
  const endMarker = createElement("w:commentRangeEnd", [["w:id", id]]);
  insertAt(endBoundary.afterPrevious ?? endBoundary.beforeNext, endMarker);
  // The reference run sits directly in the paragraph, behind whatever wraps the end of the range.
  insertAfter(topInline(endMarker), referenceRun(index, id));
  touch(context, range.end.record.element);

  const startBoundary = splitRunAt(index, startPosition);
  insertAt(startBoundary.beforeNext, createElement("w:commentRangeStart", [["w:id", id]]));

  writeComment(context, id, text);
  const first = range.start.record;
  const last = range.end.record;
  for (const record of index.blocksIn(first.container)) {
    if (record.type !== "paragraph") continue;
    if (record.indexInContainer >= first.indexInContainer && record.indexInContainer <= last.indexInContainer) {
      touch(context, record.element);
    }
  }
  return id;
}

function findComment(index: DocxIndex, id: unknown): XmlElement {
  const element = typeof id === "string" ? commentElements(index).find((entry) => attr(entry, "w:id") === id) : undefined;
  if (element === undefined) {
    throw new OfficeError("stale_reference", "unknown comment id", { details: { commentId: String(id) } });
  }
  return element;
}

/** Maps every comment to the first comment of its thread. */
function threadRoots(index: DocxIndex): Map<CommentId, CommentId> {
  const parents = new Map(listComments(index).map((comment) => [comment.id, comment.parentId] as const));
  const roots = new Map<CommentId, CommentId>();
  for (const id of parents.keys()) {
    let current = id;
    for (let hop = 0; hop < 64; hop++) {
      const parent = parents.get(current) ?? null;
      if (parent === null) break;
      current = parent;
    }
    roots.set(id, current);
  }
  return roots;
}

/** The `w14:paraId` that names a comment in `commentsExtended.xml`: that of its last paragraph, given one when missing. */
function paraIdOf(index: DocxIndex, comment: XmlElement): string {
  const paragraphs = expandChildren(comment, PARAGRAPHS);
  let last = paragraphs[paragraphs.length - 1];
  if (last === undefined) {
    last = createElement("w:p");
    appendChild(comment, last);
  }
  const known = attr(last, "w14:paraId");
  if (known !== null) return known.toUpperCase();
  commentsRoot(index);
  const created = index.allocateParaId();
  setAttr(last, "w14:paraId", created);
  index.markDirty(comment);
  return created;
}

/** The `w15:commentEx` entry of a comment, created when missing. */
function extendedEntry(index: DocxIndex, paraId: string): XmlElement {
  const root = index.ensurePart("commentsExtended");
  for (const node of root.children) {
    if (node.kind === "element" && node.name === "w15:commentEx" && (attr(node, "w15:paraId") ?? "").toUpperCase() === paraId) {
      return node;
    }
  }
  const entry = createElement("w15:commentEx", [
    ["w15:paraId", paraId],
    ["w15:done", "0"],
  ]);
  appendChild(root, entry);
  index.markDirty(entry);
  return entry;
}

function markerAt(index: DocxIndex, point: TextPoint | null, name: string, id: CommentId): XmlElement | null {
  if (point === null) return null;
  for (const marker of index.scan(point.paragraph).markers) {
    if (marker.node.name === name && attr(marker.node, "w:id") === id) return marker.node;
  }
  return null;
}

/**
 * Implements `replyComment`. The reply is a comment of its own, anchored to
 * the range of the thread, and tied to the thread in `commentsExtended.xml`.
 */
export function replyComment(context: EditContext, commentId: unknown, text: string): CommentId {
  const { index } = context;
  findComment(index, commentId);
  const rootId = threadRoots(index).get(commentId as CommentId) ?? (commentId as CommentId);
  const root = findComment(index, rootId);
  const anchor = index.flow.commentAnchors.get(rootId);
  const start = markerAt(index, anchor?.start ?? null, "w:commentRangeStart", rootId);
  const end = markerAt(index, anchor?.end ?? null, "w:commentRangeEnd", rootId);
  const reference = markerAt(index, anchor?.reference ?? null, "w:commentReference", rootId);

  const id = index.allocateCommentId();
  if (start !== null) insertAfter(start, createElement("w:commentRangeStart", [["w:id", id]]));
  let endMarker: XmlElement | null = null;
  if (end !== null) {
    endMarker = createElement("w:commentRangeEnd", [["w:id", id]]);
    insertAfter(end, endMarker);
  }
  const referenceHost = reference === null ? null : closest(reference, "w:r");
  if (referenceHost !== null) insertAfter(referenceHost, referenceRun(index, id));
  else if (endMarker !== null) insertAfter(topInline(endMarker), referenceRun(index, id));
  for (const node of [start, end, reference]) {
    const paragraph = node === null ? null : closest(node, "w:p");
    if (paragraph !== null) touch(context, paragraph);
  }

  const comment = writeComment(context, id, text);
  const parentParaId = paraIdOf(index, root);
  extendedEntry(index, parentParaId);
  const entry = extendedEntry(index, paraIdOf(index, comment));
  setAttr(entry, "w15:paraIdParent", parentParaId);
  index.markDirty(entry);
  return id;
}

/** Implements `resolveComment`: sets the done state of the whole thread. */
export function resolveComment(context: EditContext, commentId: unknown, resolved: boolean): void {
  const { index } = context;
  findComment(index, commentId);
  const roots = threadRoots(index);
  const rootId = roots.get(commentId as CommentId) ?? (commentId as CommentId);
  const members = [...roots].filter(([, root]) => root === rootId).map(([id]) => id);
  for (const member of members) {
    const entry = extendedEntry(index, paraIdOf(index, findComment(index, member)));
    setAttr(entry, "w15:done", resolved ? "1" : "0");
    index.markDirty(entry);
  }
}
