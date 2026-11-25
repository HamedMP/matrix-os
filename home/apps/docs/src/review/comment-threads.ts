/**
 * Comment threads: the engine's flat comment list grouped into threads
 * anchored to ranges, in document order. Pure functions.
 */

import type { CommentId, DocxComment, TextPosition, TextRange } from "../../../_shared/office-engine/index";
import type { ModelIndex } from "../editor/model-index";
import { type PositionKey, compareKeys, positionKey } from "./revision-items";

/** Longest comment or reply accepted from the panel, in characters. */
export const MAX_COMMENT_LENGTH = 10_000;

export interface CommentThread {
  /** The id of the first comment; replies may name any comment of the thread. */
  id: CommentId;
  root: DocxComment;
  /** Oldest first. */
  replies: DocxComment[];
  /** Null when the anchored text is gone. */
  range: TextRange | null;
  /** The anchored text in the final view. Untrusted document text. */
  anchorText: string;
  resolved: boolean;
  /** Document order of the anchor; threads without one sort last. */
  position: PositionKey;
}

export interface ThreadFilter {
  /** Show threads marked as done. Default false. */
  showResolved: boolean;
}

/**
 * The thread root of a comment: follows `parentId` up. An unknown parent ends
 * the walk; a cycle (a damaged file) ends at the cycle's first-listed comment,
 * so every member of the cycle lands in the same thread.
 */
function rootOf(comment: DocxComment, byId: ReadonlyMap<CommentId, DocxComment>, listed: ReadonlyMap<CommentId, number>): DocxComment {
  const chain: DocxComment[] = [comment];
  let current = comment;
  while (current.parentId !== null) {
    const parent = byId.get(current.parentId);
    if (parent === undefined) break;
    const seenAt = chain.indexOf(parent);
    if (seenAt >= 0) {
      return chain.slice(seenAt).reduce((first, member) => (listed.get(member.id)! < listed.get(first.id)! ? member : first));
    }
    chain.push(parent);
    current = parent;
  }
  return current;
}

const LAST: PositionKey = { paragraph: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER };

/** Threads in document order of their anchors; replies oldest first. */
export function buildThreads(comments: readonly DocxComment[], index: ModelIndex): CommentThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const listed = new Map(comments.map((comment, at) => [comment.id, at]));
  const threads = new Map<CommentId, CommentThread>();
  comments.forEach((comment) => {
    const root = rootOf(comment, byId, listed);
    let thread = threads.get(root.id);
    if (thread === undefined) {
      thread = {
        id: root.id,
        root,
        replies: [],
        range: root.range,
        anchorText: root.anchorText,
        resolved: root.resolved,
        position: root.range === null ? LAST : positionKey(index, root.range.start),
      };
      threads.set(root.id, thread);
    }
    if (comment.id !== root.id) thread.replies.push(comment);
  });
  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => (Date.parse(a.date ?? "") || 0) - (Date.parse(b.date ?? "") || 0));
  }
  return [...threads.values()].sort((a, b) => compareKeys(a.position, b.position) || listed.get(a.id)! - listed.get(b.id)!);
}

export function filterThreads(threads: readonly CommentThread[], filter: ThreadFilter): CommentThread[] {
  return filter.showResolved ? [...threads] : threads.filter((thread) => !thread.resolved);
}

/** The thread whose comment ids include one of `ids` (for a click on a commented span). */
export function threadOfComment(threads: readonly CommentThread[], id: CommentId): CommentThread | null {
  return threads.find((thread) => thread.id === id || thread.replies.some((reply) => reply.id === id)) ?? null;
}

/** The threads anchored at a caret or touching a selection. */
export function threadsAt(threads: readonly CommentThread[], index: ModelIndex, position: TextPosition): CommentThread[] {
  const at = positionKey(index, position);
  return threads.filter((thread) => {
    if (thread.range === null) return false;
    return compareKeys(positionKey(index, thread.range.start), at) <= 0 && compareKeys(at, positionKey(index, thread.range.end)) <= 0;
  });
}

export type CommentTextCheck = { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" };

/** Trims comment text and checks it is neither empty nor too long. Line breaks are kept. */
export function checkCommentText(text: string): CommentTextCheck {
  // Line breaks separate paragraphs; other control characters cannot be stored.
  // eslint-disable-next-line no-control-regex
  const trimmed = text.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_COMMENT_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, text: trimmed };
}
