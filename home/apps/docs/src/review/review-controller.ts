/**
 * The state of revision review and comments for one document session:
 * the pending revisions and comment threads, the filter, the current
 * revision and the active thread. It follows the session's changes, keeps
 * the editor's review highlights in step, and runs every accept, reject and
 * comment action through the session so each one can be undone.
 *
 * React reads it with `subscribe` + `getSnapshot` (`useSyncExternalStore`).
 */

import type { RevisionId, RevisionKind } from "../../../_shared/office-engine/index";
import { ModelIndex } from "../editor/model-index";
import { addListener } from "../listeners";
import type { DocumentEditorController } from "../editor/types";
import type { DocumentChange, DocumentSession } from "../session/index";
import { type CommentThread, buildThreads, filterThreads } from "./comment-threads";
import {
  COMMENT_LAYER,
  COMMENT_MARK_LAYER,
  REVIEW_LAYER,
  activeThreadHighlights,
  revisionHighlights,
  threadMarkHighlights,
} from "./review-highlights";
import {
  type AuthorGroup,
  type ReviewFilter,
  EMPTY_FILTER,
  authorsOf,
  filterItems,
  groupByAuthor,
  isFilterActive,
  itemsInRange,
  stepItem,
} from "./review-filters";
import {
  type CommentOutcome,
  type ResolveAction,
  type ResolveOutcome,
  type ReviewLog,
  acceptFormattingChanges,
  addComment,
  replyToComment,
  resolveByAuthor,
  resolveRevisions,
  setCommentResolved,
} from "./review-actions";
import { type ReviewItem, listReviewItems, positionKey } from "./revision-items";
import { type ShortcutEvent, matchReviewShortcut } from "./shortcuts";

/** The part of the editor controller the review needs. */
export type ReviewEditor = Pick<DocumentEditorController, "scrollTo" | "setHighlights" | "getSelection">;

/** Immutable; replaced on every change. */
export interface ReviewSnapshot {
  /** Every pending revision in document order. */
  items: readonly ReviewItem[];
  /** The revisions the filter lets through. */
  visible: readonly ReviewItem[];
  /** `visible` by author. */
  groups: readonly AuthorGroup[];
  /** Every author with a pending revision. */
  authors: readonly string[];
  filter: ReviewFilter;
  filtered: boolean;
  current: ReviewItem | null;
  /** Index of `current` in `visible`, or -1. */
  currentIndex: number;
  /** Pending formatting revisions, whatever the filter. */
  formattingCount: number;
  threads: readonly CommentThread[];
  /** Threads the thread filter shows. */
  visibleThreads: readonly CommentThread[];
  showResolved: boolean;
  activeThread: CommentThread | null;
  /** Bumped when the owner asks to write a comment (the shortcut); the comment box takes focus. */
  composeRequest: number;
  /** A fixed sentence about the last failed accept or reject, safe to display. */
  error: string | null;
  /** A fixed sentence about the last failed comment action, safe to display. */
  commentError: string | null;
}

export interface ReviewControllerOptions {
  editor?: ReviewEditor | null;
  log?: ReviewLog;
}

const MESSAGES = {
  resolve: "That change could not be applied. The document is unchanged.",
  stale: "That change is no longer in the document.",
  empty: "Write something first.",
  tooLong: "That comment is too long.",
  noSelection: "Select the text to comment on first.",
  invalidRange: "A comment can't span that selection. Select text within one paragraph or neighbouring paragraphs.",
  notFound: "That comment is no longer in the document.",
  comment: "The comment could not be saved.",
} as const;

export class ReviewController {
  private readonly session: DocumentSession;
  private readonly log: ReviewLog;
  private editor: ReviewEditor | null;
  private index = ModelIndex.empty();
  private filter: ReviewFilter = EMPTY_FILTER;
  private currentId: RevisionId | null = null;
  private activeThreadId: string | null = null;
  private showResolved = false;
  private composeRequest = 0;
  private error: string | null = null;
  private commentError: string | null = null;
  private items: readonly ReviewItem[] = [];
  private threads: readonly CommentThread[] = [];
  private snapshot: ReviewSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly stop: () => void;

  constructor(session: DocumentSession, options: ReviewControllerOptions = {}) {
    this.session = session;
    this.editor = options.editor ?? null;
    this.log = options.log ?? ((message, error) => console.warn(message, error));
    this.stop = session.onChange((change) => this.onSessionChange(change));
    this.rebuild();
    this.snapshot = this.build();
    this.paint();
  }

  // ---------------------------------------------------------------- state

  getSnapshot = (): ReviewSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => addListener(this.listeners, listener, "review");

  /** Connects the editor whose highlights and scrolling follow the review; null disconnects it. */
  attachEditor(editor: ReviewEditor | null): void {
    if (this.editor === editor) return;
    this.clearPaint();
    this.editor = editor;
    this.paint();
  }

  dispose(): void {
    this.stop();
    this.clearPaint();
    this.listeners.clear();
    this.editor = null;
  }

  // ---------------------------------------------------------------- filter and navigation

  setFilter(patch: Partial<ReviewFilter>): void {
    this.filter = { ...this.filter, ...patch };
    this.publish();
  }

  clearFilter(): void {
    this.filter = EMPTY_FILTER;
    this.publish();
  }

  /** Makes a revision current, highlights it and scrolls it into view. False when it is not pending. */
  select(id: RevisionId | null, options: { scroll?: boolean } = {}): boolean {
    if (id !== null && !this.items.some((item) => item.id === id)) return false;
    this.currentId = id;
    this.publish();
    if (id !== null && options.scroll !== false) this.reveal(this.snapshot.current);
    return true;
  }

  /** Steps to the next shown revision in document order, from the current one or else from the caret. */
  next(): boolean {
    return this.step("next");
  }

  previous(): boolean {
    return this.step("previous");
  }

  // ---------------------------------------------------------------- accept and reject

  /** Accepts one revision (default: the current one) and moves on to the next. */
  accept(id: RevisionId | null = this.currentId): ResolveOutcome {
    return this.resolveOne("accept", id);
  }

  reject(id: RevisionId | null = this.currentId): ResolveOutcome {
    return this.resolveOne("reject", id);
  }

  /** Accepts every shown revision: all of them, or those the filter lets through. */
  acceptAll(): ResolveOutcome {
    return this.resolveShown("accept");
  }

  rejectAll(): ResolveOutcome {
    return this.resolveShown("reject");
  }

  acceptByAuthor(author: string): ResolveOutcome {
    return this.report(resolveByAuthor(this.session, "accept", author, this.log));
  }

  rejectByAuthor(author: string): ResolveOutcome {
    return this.report(resolveByAuthor(this.session, "reject", author, this.log));
  }

  /** The shown revisions the editor selection touches (a caret touches the change it is in). */
  selectedItems(): ReviewItem[] {
    const selection = this.editor?.getSelection() ?? null;
    if (selection === null) return [];
    return itemsInRange(this.snapshot.visible, this.index, { start: selection.start, end: selection.end });
  }

  acceptSelection(): ResolveOutcome {
    return this.resolveIds("accept", this.selectedItems().map((item) => item.id));
  }

  rejectSelection(): ResolveOutcome {
    return this.resolveIds("reject", this.selectedItems().map((item) => item.id));
  }

  /** Accepts every formatting change and keeps the substantive ones for review. One undo step. */
  acceptFormatting(): ResolveOutcome {
    return this.report(acceptFormattingChanges(this.session, this.log));
  }

  // ---------------------------------------------------------------- comments

  setShowResolved(show: boolean): void {
    this.showResolved = show;
    this.publish();
  }

  /** Makes a thread active: its range is highlighted and scrolled into view. */
  selectThread(id: string | null, options: { scroll?: boolean } = {}): boolean {
    const thread = id === null ? null : (this.threads.find((candidate) => candidate.id === id) ?? null);
    if (id !== null && thread === null) return false;
    this.activeThreadId = id;
    this.publish();
    if (thread?.range != null && options.scroll !== false) this.editor?.scrollTo(thread.range, { behavior: "smooth" });
    return true;
  }

  /** Starts a thread on the editor selection; the new thread becomes active. */
  addComment(text: string): CommentOutcome {
    const selection = this.editor?.getSelection() ?? null;
    const range = selection === null ? null : { start: selection.start, end: selection.end };
    const outcome = this.reportComment(addComment(this.session, range, text, this.log));
    if (outcome.ok && outcome.commentId !== null) this.selectThread(outcome.commentId, { scroll: false });
    return outcome;
  }

  reply(threadId: string, text: string): CommentOutcome {
    return this.reportComment(replyToComment(this.session, threadId, text, this.log));
  }

  resolveThread(threadId: string, resolved = true): CommentOutcome {
    return this.reportComment(setCommentResolved(this.session, threadId, resolved, this.log));
  }

  /** Asks the comment box to take focus (`snapshot.composeRequest`). */
  requestComment(): void {
    this.composeRequest++;
    this.publish();
  }

  /** Clears the messages of failed actions. */
  dismissError(): void {
    if (this.error === null && this.commentError === null) return;
    this.error = null;
    this.commentError = null;
    this.publish();
  }

  /** Runs the review command bound to a key press. True when one ran; the caller then cancels the event. */
  handleShortcut(event: ShortcutEvent): boolean {
    const command = matchReviewShortcut(event);
    if (command === null || this.session.document === null) return false;
    if (command === "next") this.next();
    else if (command === "previous") this.previous();
    else if (command === "accept") {
      if (this.currentId !== null) this.accept();
      else this.acceptSelection();
    } else if (command === "reject") {
      if (this.currentId !== null) this.reject();
      else this.rejectSelection();
    } else this.requestComment();
    return true;
  }

  // ---------------------------------------------------------------- internals

  private step(direction: "next" | "previous"): boolean {
    const visible = this.snapshot.visible;
    const selection = this.editor?.getSelection() ?? null;
    const caret = selection === null ? null : positionKey(this.index, direction === "next" ? selection.end : selection.start);
    const target = stepItem(visible, { currentId: this.currentId, caret }, direction);
    if (target === null) return false;
    return this.select(target.id);
  }

  private resolveOne(action: ResolveAction, id: RevisionId | null): ResolveOutcome {
    if (id === null) return { ok: false, reason: "nothing" };
    return this.resolveIds(action, [id]);
  }

  private resolveShown(action: ResolveAction): ResolveOutcome {
    if (!isFilterActive(this.filter)) return this.report(resolveRevisions(this.session, action, "all", this.log));
    return this.resolveIds(action, this.snapshot.visible.map((item) => item.id));
  }

  /** Resolves ids and, when the current revision went with them, moves on to the next shown one. */
  private resolveIds(action: ResolveAction, ids: readonly RevisionId[]): ResolveOutcome {
    if (ids.length === 0) return { ok: false, reason: "nothing" };
    const visible = this.snapshot.visible;
    const from = this.currentId === null ? -1 : visible.findIndex((item) => item.id === this.currentId);
    const after = from < 0 ? [] : visible.slice(from + 1).map((item) => item.id);
    const before = from < 0 ? [] : visible.slice(0, from).map((item) => item.id).reverse();
    const outcome = this.report(resolveRevisions(this.session, action, ids, this.log));
    if (outcome.ok && from >= 0 && this.currentId === null) {
      const pending = new Set(this.snapshot.visible.map((item) => item.id));
      const successor = after.find((id) => pending.has(id)) ?? before.find((id) => pending.has(id)) ?? null;
      if (successor !== null) this.select(successor);
    }
    return outcome;
  }

  private report(outcome: ResolveOutcome): ResolveOutcome {
    if (!outcome.ok && outcome.reason === "failed") this.error = MESSAGES.resolve;
    else if (outcome.ok) this.error = null;
    else return outcome;
    this.publish();
    return outcome;
  }

  private reportComment(outcome: CommentOutcome): CommentOutcome {
    if (outcome.ok) {
      if (this.commentError !== null) {
        this.commentError = null;
        this.publish();
      }
      return outcome;
    }
    const messages: Record<typeof outcome.reason, string> = {
      empty: MESSAGES.empty,
      too_long: MESSAGES.tooLong,
      no_selection: MESSAGES.noSelection,
      invalid_range: MESSAGES.invalidRange,
      not_found: MESSAGES.notFound,
      failed: MESSAGES.comment,
    };
    this.commentError = messages[outcome.reason];
    this.publish();
    return outcome;
  }

  private onSessionChange(change: DocumentChange): void {
    if (change.kind === "load" || change.kind === "close") {
      this.currentId = null;
      this.activeThreadId = null;
      this.error = null;
      this.commentError = null;
      this.filter = EMPTY_FILTER;
    } else if (!this.mayMatter(change)) return;
    this.rebuild();
    this.publish();
    // The editor clears every highlight when a document loads; when it hears
    // about the load after this controller did, paint again once it has.
    if (change.kind === "load") queueMicrotask(() => this.paint());
  }

  /** Typing in a document without revisions or comments cannot change the review. */
  private mayMatter(change: DocumentChange): boolean {
    if (change.full || change.revisionIds.length > 0 || change.kind !== "edit") return true;
    const state = this.session.getState();
    return this.items.length > 0 || this.threads.length > 0 || state.revisionCount > 0 || state.commentCount > 0;
  }

  private rebuild(): void {
    const doc = this.session.document;
    if (doc === null) {
      this.index = ModelIndex.empty();
      this.items = [];
      this.threads = [];
    } else {
      this.index = ModelIndex.build(doc.getView());
      this.items = listReviewItems(doc, this.index);
      this.threads = buildThreads(doc.listComments(), this.index);
    }
    if (this.currentId !== null && !this.items.some((item) => item.id === this.currentId)) this.currentId = null;
    if (this.activeThreadId !== null && !this.threads.some((thread) => thread.id === this.activeThreadId)) this.activeThreadId = null;
  }

  private build(): ReviewSnapshot {
    const visible = filterItems(this.items, this.filter);
    let currentIndex = this.currentId === null ? -1 : visible.findIndex((item) => item.id === this.currentId);
    // A current revision the filter hides stops being current.
    if (currentIndex < 0) this.currentId = null;
    const current = currentIndex < 0 ? null : visible[currentIndex]!;
    if (current === null) currentIndex = -1;
    const visibleThreads = filterThreads(this.threads, { showResolved: this.showResolved });
    return Object.freeze({
      items: this.items,
      visible,
      groups: groupByAuthor(visible),
      authors: authorsOf(this.items),
      filter: this.filter,
      filtered: isFilterActive(this.filter),
      current,
      currentIndex,
      formattingCount: this.items.filter((item) => item.category === "formatting").length,
      threads: this.threads,
      visibleThreads,
      showResolved: this.showResolved,
      activeThread: this.threads.find((thread) => thread.id === this.activeThreadId) ?? null,
      composeRequest: this.composeRequest,
      error: this.error,
      commentError: this.commentError,
    });
  }

  private publish(): void {
    this.snapshot = this.build();
    this.paint();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.log("docs: a review listener failed", error);
      }
    }
  }

  private paint(): void {
    const editor = this.editor;
    if (editor === null) return;
    const doc = this.session.document;
    editor.setHighlights(REVIEW_LAYER, revisionHighlights(this.snapshot.current, doc, this.index));
    editor.setHighlights(COMMENT_LAYER, activeThreadHighlights(this.snapshot.activeThread));
    editor.setHighlights(COMMENT_MARK_LAYER, threadMarkHighlights(this.threads));
  }

  private clearPaint(): void {
    const editor = this.editor;
    if (editor === null) return;
    for (const layer of [REVIEW_LAYER, COMMENT_LAYER, COMMENT_MARK_LAYER]) editor.setHighlights(layer, []);
  }

  private reveal(item: ReviewItem | null): void {
    if (item === null || this.editor === null) return;
    const target = item.range ?? item.anchor;
    if (target !== null) this.editor.scrollTo(target, { behavior: "smooth" });
    else if (item.blockIds[0] !== undefined) this.editor.scrollTo(item.blockIds[0], { behavior: "smooth" });
  }
}

/** Kinds offered by the kind filter; moves are one choice covering both halves. */
export const KIND_FILTERS: ReadonlyArray<{ id: string; label: string; kinds: RevisionKind[] }> = Object.freeze([
  { id: "insert", label: "Insertions", kinds: ["insert"] },
  { id: "delete", label: "Deletions", kinds: ["delete"] },
  { id: "move", label: "Moves", kinds: ["moveFrom", "moveTo"] },
  { id: "format", label: "Formatting", kinds: ["format"] },
]);
