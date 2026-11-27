/**
 * Comments: `word/comments.xml`, the threading and done state in
 * `word/commentsExtended.xml`, and the ranges the stories anchor them to.
 */

import type { CommentId, DocxComment, TextPosition, TextRange } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import type { DocxIndex } from "./doc-index.js";
import type { CommentAnchor, TextPoint } from "./flow.js";
import { scanParagraph } from "./inline.js";
import { attr, isOn } from "./names.js";
import { paragraphText, rangeText } from "./plain-text.js";
import { expandChildren } from "./structure.js";

const PARAGRAPHS: ReadonlySet<string> = new Set(["w:p"]);

interface CommentSource {
  readonly id: CommentId;
  readonly element: XmlElement;
  readonly fileOrder: number;
  /** `w14:paraId` of the last paragraph: the key of the comment in `commentsExtended.xml`. */
  readonly paraId: string | null;
  readonly paraIds: readonly string[];
}

/** The `w:comment` elements of the document, in file order. */
export function commentElements(index: DocxIndex): XmlElement[] {
  const root = index.partRoot("comments");
  const found: XmlElement[] = [];
  if (root === null) return found;
  for (const node of root.children) if (node.kind === "element" && node.name === "w:comment") found.push(node);
  return found;
}

function readSources(index: DocxIndex): CommentSource[] {
  const sources: CommentSource[] = [];
  const seen = new Set<string>();
  for (const element of commentElements(index)) {
    const id = attr(element, "w:id");
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const paraIds: string[] = [];
    for (const paragraph of expandChildren(element, PARAGRAPHS)) {
      const paraId = attr(paragraph, "w14:paraId");
      if (paraId !== null) paraIds.push(paraId.toUpperCase());
    }
    sources.push({ id, element, fileOrder: sources.length, paraId: paraIds[paraIds.length - 1] ?? null, paraIds });
  }
  return sources;
}

function commentText(element: XmlElement): string {
  const lines: string[] = [];
  for (const paragraph of expandChildren(element, PARAGRAPHS)) {
    lines.push(paragraphText(scanParagraph(paragraph, [], -1), "final"));
  }
  return lines.join("\n");
}

function toPosition(index: DocxIndex, point: TextPoint): TextPosition | null {
  const record = index.blockOf(point.paragraph);
  return record === null ? null : { blockId: record.id, offset: point.offset };
}

function rangeOf(index: DocxIndex, anchor: CommentAnchor | undefined): { range: TextRange; sort: [number, number] } | null {
  if (anchor === undefined) return null;
  let startPoint = anchor.start ?? anchor.end ?? anchor.reference;
  let endPoint = anchor.end ?? anchor.start ?? anchor.reference;
  if (startPoint === null || endPoint === null) return null;
  const order = index.flow.order;
  const startOrder = order.get(startPoint.paragraph) ?? 0;
  const endOrder = order.get(endPoint.paragraph) ?? 0;
  if (startOrder > endOrder || (startOrder === endOrder && startPoint.offset > endPoint.offset)) {
    [startPoint, endPoint] = [endPoint, startPoint];
  }
  const start = toPosition(index, startPoint);
  const end = toPosition(index, endPoint);
  if (start === null || end === null) return null;
  return { range: { start, end }, sort: [Math.min(startOrder, endOrder), startPoint.offset] };
}

function anchorTextOf(index: DocxIndex, range: TextRange): string {
  const start = index.block(range.start.blockId);
  const end = index.block(range.end.blockId);
  // A range read from a file can break the sibling rule; then only its first paragraph is quoted.
  if (start === null || end === null) return "";
  if (start !== end && (start.container !== end.container || start.indexInContainer > end.indexInContainer)) {
    return paragraphText(index.scan(start.element), "final", range.start.offset);
  }
  return rangeText(index, range, "final");
}

/** All comments, in document order of their anchors; replies follow their thread's first comment, oldest first. */
export function listComments(index: DocxIndex): DocxComment[] {
  const sources = readSources(index);
  if (sources.length === 0) return [];

  // Threading: a reply names the paragraph id of the comment it answers.
  const byParaId = new Map<string, CommentSource>();
  for (const source of sources) for (const paraId of source.paraIds) if (!byParaId.has(paraId)) byParaId.set(paraId, source);
  const parentOf = new Map<CommentId, CommentId>();
  const done = new Set<CommentId>();
  const extended = index.partRoot("commentsExtended");
  if (extended !== null) {
    for (const node of extended.children) {
      if (node.kind !== "element" || node.name !== "w15:commentEx") continue;
      const own = byParaId.get((attr(node, "w15:paraId") ?? "").toUpperCase());
      if (own === undefined) continue;
      const doneValue = attr(node, "w15:done");
      if (doneValue !== null && isOn(doneValue)) done.add(own.id);
      const parent = byParaId.get((attr(node, "w15:paraIdParent") ?? "").toUpperCase());
      if (parent !== undefined && parent !== own) parentOf.set(own.id, parent.id);
    }
  }
  const rootOf = (id: CommentId): CommentId => {
    let current = id;
    for (let hop = 0; hop < 64; hop++) {
      const parent = parentOf.get(current);
      if (parent === undefined || parent === id) break;
      current = parent;
    }
    return current;
  };

  const anchors = index.flow.commentAnchors;
  const built = new Map<CommentId, { comment: DocxComment; source: CommentSource; sort: [number, number] }>();
  for (const source of sources) {
    const rootId = rootOf(source.id);
    const located = rangeOf(index, anchors.get(rootId)) ?? (rootId === source.id ? null : rangeOf(index, anchors.get(source.id)));
    const element = source.element;
    built.set(source.id, {
      source,
      sort: located?.sort ?? [Number.POSITIVE_INFINITY, 0],
      comment: {
        id: source.id,
        parentId: parentOf.get(source.id) ?? null,
        author: attr(element, "w:author") ?? "",
        initials: attr(element, "w:initials"),
        date: attr(element, "w:date"),
        text: commentText(element),
        range: located?.range ?? null,
        anchorText: located === null || located === undefined ? "" : anchorTextOf(index, located.range),
        resolved: done.has(rootId),
      },
    });
  }

  const roots = [...built.values()]
    .filter((entry) => entry.comment.parentId === null)
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.source.fileOrder - b.source.fileOrder);
  const result: DocxComment[] = [];
  for (const root of roots) {
    result.push(root.comment);
    const replies = [...built.values()]
      .filter((entry) => entry.comment.parentId !== null && rootOf(entry.comment.id) === root.comment.id)
      .sort((a, b) => {
        const left = a.comment.date ?? "";
        const right = b.comment.date ?? "";
        return left < right ? -1 : left > right ? 1 : a.source.fileOrder - b.source.fileOrder;
      });
    for (const reply of replies) result.push(reply.comment);
  }
  return result;
}
