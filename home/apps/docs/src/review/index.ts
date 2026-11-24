/**
 * Docs revision review and comments: the logic behind the review panel.
 * The React components are in `../ui/review`.
 *
 * ```ts
 * const review = new ReviewController(session, { editor });   // editor: DocumentEditorController
 * const snapshot = useSyncExternalStore(review.subscribe, review.getSnapshot);
 *
 * review.next();                              // steps in document order; scrolls and highlights in the editor
 * review.accept();                            // the current revision, then moves on; one undo step
 * review.acceptByAuthor("Alex Morgan");
 * review.acceptFormatting();                  // formatting accepted, substantive changes kept for review
 * review.setFilter({ category: "substantive" });
 * review.addComment("Is this right?");        // on the editor selection
 * review.reply(threadId, "Yes");
 * review.resolveThread(threadId);
 * review.dispose();
 * ```
 *
 * Every accept, reject and comment action runs through the session with
 * origin `review` (`REVIEW_ORIGIN`), so `session.undo()` reverses it. The
 * pure helpers (`listReviewItems`, `groupByAuthor`, `filterItems`,
 * `stepItem`, `itemsInRange`, `buildThreads`) need only an engine document.
 *
 * Editor highlight layers it owns: `review` (current revision),
 * `comment` (active thread) and `comment-mark` (every open thread; the
 * paragraph shows a margin mark, styled by `../ui/review/review.css`).
 *
 * Shortcuts (`matchReviewShortcut`): Alt+Shift+N next, Alt+Shift+P previous,
 * Alt+Shift+A accept, Alt+Shift+R reject, Alt+Shift+M comment.
 */

export {
  type ReviewCategory,
  type ReviewItem,
  type PositionKey,
  compareKeys,
  describeFormatChange,
  excerptOf,
  formatReviewDate,
  listReviewItems,
  positionKey,
  revisionKindLabel,
} from "./revision-items";
export {
  type AuthorGroup,
  type CategoryFilter,
  type ReviewFilter,
  type StepDirection,
  type StepFrom,
  EMPTY_FILTER,
  authorsOf,
  filterItems,
  groupByAuthor,
  isFilterActive,
  itemsInRange,
  matchesFilter,
  stepItem,
} from "./review-filters";
export {
  type CommentTextCheck,
  type CommentThread,
  type ThreadFilter,
  MAX_COMMENT_LENGTH,
  buildThreads,
  checkCommentText,
  filterThreads,
  threadOfComment,
  threadsAt,
} from "./comment-threads";
export {
  type CommentOutcome,
  type ResolveAction,
  type ResolveOutcome,
  type ReviewLog,
  REVIEW_ORIGIN,
  acceptFormattingChanges,
  addComment,
  replyToComment,
  resolveByAuthor,
  resolveRevisions,
  setCommentResolved,
} from "./review-actions";
export {
  COMMENT_LAYER,
  COMMENT_MARK_LAYER,
  REVIEW_LAYER,
  idsFromHighlight,
  revisionRanges,
} from "./review-highlights";
export { type ReviewCommand, type ShortcutEvent, REVIEW_SHORTCUTS, matchReviewShortcut } from "./shortcuts";
export {
  type ReviewControllerOptions,
  type ReviewEditor,
  type ReviewSnapshot,
  KIND_FILTERS,
  ReviewController,
} from "./review-controller";
