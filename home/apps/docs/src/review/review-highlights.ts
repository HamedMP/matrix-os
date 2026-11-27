/**
 * The ranges the review panel paints in the editor through its highlight
 * API: the current revision, the active comment thread, and a margin mark on
 * every paragraph with an open thread.
 */

import type { DocxDocument, TextRange } from "../../../_shared/office-engine/index";
import type { EditorHighlight } from "../editor/types";
import type { ModelIndex } from "../editor/model-index";
import type { CommentThread } from "./comment-threads";
import type { ReviewItem } from "./revision-items";

/** Layer of the current revision. Spans get `doc-hl-review`. */
export const REVIEW_LAYER = "review";
/** Layer of the active thread's range. Spans get `doc-hl-comment` (styled by the editor). */
export const COMMENT_LAYER = "comment";
/** Layer of every open thread; the paragraph shows a mark in its margin. Spans get `doc-hl-comment-mark`. */
export const COMMENT_MARK_LAYER = "comment-mark";

export const THREAD_HIGHLIGHT_PREFIX = "thread:";
export const REVISION_HIGHLIGHT_PREFIX = "revision:";

/** The ranges that show a revision: its text range, or each of its paragraphs whole. */
export function revisionRanges(item: ReviewItem, doc: DocxDocument, index: ModelIndex): TextRange[] {
  if (item.range !== null) return [item.range];
  const ranges: TextRange[] = [];
  for (const blockId of item.blockIds) {
    if (index.entry(blockId) === null) continue;
    const block = doc.getBlock(blockId);
    if (block === null || block.type !== "paragraph") continue;
    // An empty paragraph still gets a range so its row or format change can be found.
    ranges.push({ start: { blockId, offset: 0 }, end: { blockId, offset: block.text.length } });
  }
  return ranges;
}

export function revisionHighlights(item: ReviewItem | null, doc: DocxDocument | null, index: ModelIndex): EditorHighlight[] {
  if (item === null || doc === null) return [];
  const id = `${REVISION_HIGHLIGHT_PREFIX}${item.id}`;
  return revisionRanges(item, doc, index).map((range) => ({ id, range, className: "is-current" }));
}

export function activeThreadHighlights(thread: CommentThread | null): EditorHighlight[] {
  if (thread === null || thread.range === null) return [];
  return [{ id: `${THREAD_HIGHLIGHT_PREFIX}${thread.id}`, range: thread.range, className: "is-current" }];
}

export function threadMarkHighlights(threads: readonly CommentThread[]): EditorHighlight[] {
  const marks: EditorHighlight[] = [];
  for (const thread of threads) {
    if (thread.resolved || thread.range === null) continue;
    marks.push({ id: `${THREAD_HIGHLIGHT_PREFIX}${thread.id}`, range: thread.range });
  }
  return marks;
}

/** The thread and revision ids named by a painted span's `data-hl-id`. */
export function idsFromHighlight(value: string | null): { threadIds: string[]; revisionIds: string[] } {
  const threadIds: string[] = [];
  const revisionIds: string[] = [];
  for (const token of (value ?? "").split(/\s+/)) {
    if (token.startsWith(THREAD_HIGHLIGHT_PREFIX)) threadIds.push(token.slice(THREAD_HIGHLIGHT_PREFIX.length));
    else if (token.startsWith(REVISION_HIGHLIGHT_PREFIX)) revisionIds.push(token.slice(REVISION_HIGHLIGHT_PREFIX.length));
  }
  return { threadIds, revisionIds };
}
