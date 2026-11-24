/**
 * Review actions on a document session: accepting and rejecting revisions,
 * and adding, answering and resolving comments. Every action goes through
 * the session, so each one is a single undo step and marks the document
 * changed. Ids that are no longer in the document are skipped instead of
 * failing the whole action.
 */

import type { CommentId, RevisionId, TextRange } from "../../../_shared/office-engine/index";
import { isOfficeError } from "../../../_shared/office-engine/errors";
import type { DocumentSession } from "../session/index";
import { checkCommentText } from "./comment-threads";

/** `DocumentChange.origin` of every change made from the review panel. */
export const REVIEW_ORIGIN = "review";

export type ResolveAction = "accept" | "reject";

export type ResolveOutcome =
  | { ok: true; resolvedIds: RevisionId[] }
  /** No open document, or none of the ids is pending any more. */
  | { ok: false; reason: "nothing" }
  /** The engine refused; the document is unchanged. */
  | { ok: false; reason: "failed" };

export type CommentOutcome =
  | { ok: true; commentId: CommentId | null }
  | { ok: false; reason: "empty" | "too_long" | "no_selection" | "not_found" | "invalid_range" | "failed" };

export type ReviewLog = (message: string, error: unknown) => void;

const defaultLog: ReviewLog = (message, error) => console.warn(message, error);

function pendingIds(session: DocumentSession): Set<RevisionId> | null {
  const doc = session.document;
  return doc === null ? null : new Set(doc.listRevisions().map((revision) => revision.id));
}

/**
 * Accepts or rejects revisions as one undo step. `"all"` resolves every
 * pending revision. Unknown ids are skipped.
 */
export function resolveRevisions(session: DocumentSession, action: ResolveAction, ids: readonly RevisionId[] | "all", log: ReviewLog = defaultLog): ResolveOutcome {
  const pending = pendingIds(session);
  if (pending === null || pending.size === 0) return { ok: false, reason: "nothing" };
  const targets = ids === "all" ? "all" : [...new Set(ids)].filter((id) => pending.has(id));
  if (targets !== "all" && targets.length === 0) return { ok: false, reason: "nothing" };
  try {
    const result = action === "accept" ? session.acceptRevisions(targets, { origin: REVIEW_ORIGIN }) : session.rejectRevisions(targets, { origin: REVIEW_ORIGIN });
    return { ok: true, resolvedIds: result.resolvedIds };
  } catch (error) {
    if (!isOfficeError(error)) throw error;
    log("docs: could not resolve revisions", error);
    return { ok: false, reason: "failed" };
  }
}

/** Accepts or rejects every pending revision by one author. */
export function resolveByAuthor(session: DocumentSession, action: ResolveAction, author: string, log: ReviewLog = defaultLog): ResolveOutcome {
  const doc = session.document;
  if (doc === null) return { ok: false, reason: "nothing" };
  const ids = doc.listRevisions().filter((revision) => revision.author === author).map((revision) => revision.id);
  return resolveRevisions(session, action, ids, log);
}

/**
 * Accepts every formatting revision and leaves the substantive ones (text,
 * moves, table rows) pending for review. One undo step.
 */
export function acceptFormattingChanges(session: DocumentSession, log: ReviewLog = defaultLog): ResolveOutcome {
  const doc = session.document;
  if (doc === null) return { ok: false, reason: "nothing" };
  const ids = doc.listRevisions().filter((revision) => revision.kind === "format").map((revision) => revision.id);
  return resolveRevisions(session, "accept", ids, log);
}

function runCommentOp(session: DocumentSession, op: Parameters<DocumentSession["apply"]>[0][number], log: ReviewLog): CommentOutcome {
  if (session.document === null) return { ok: false, reason: "not_found" };
  try {
    const result = session.apply([op], { track: false, origin: REVIEW_ORIGIN });
    return { ok: true, commentId: result.results[0]?.commentId ?? null };
  } catch (error) {
    if (!isOfficeError(error)) throw error;
    log("docs: the comment could not be saved", error);
    if (isOfficeError(error, "stale_reference")) return { ok: false, reason: "not_found" };
    if (isOfficeError(error, "invalid_operation", "invalid_argument")) return { ok: false, reason: "invalid_range" };
    return { ok: false, reason: "failed" };
  }
}

function isEmptyRange(range: TextRange): boolean {
  return range.start.blockId === range.end.blockId && range.start.offset === range.end.offset;
}

/** Starts a thread on a range by the session author. The range must not be empty. */
export function addComment(session: DocumentSession, range: TextRange | null, text: string, log: ReviewLog = defaultLog): CommentOutcome {
  if (range === null || isEmptyRange(range)) return { ok: false, reason: "no_selection" };
  const checked = checkCommentText(text);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return runCommentOp(session, { type: "addComment", range, text: checked.text }, log);
}

/** Adds a reply to the thread of `commentId`. */
export function replyToComment(session: DocumentSession, commentId: CommentId, text: string, log: ReviewLog = defaultLog): CommentOutcome {
  const checked = checkCommentText(text);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return runCommentOp(session, { type: "replyComment", commentId, text: checked.text }, log);
}

/** Marks the thread of `commentId` as done, or reopens it. */
export function setCommentResolved(session: DocumentSession, commentId: CommentId, resolved: boolean, log: ReviewLog = defaultLog): CommentOutcome {
  return runCommentOp(session, { type: "resolveComment", commentId, resolved }, log);
}
