/**
 * Docs review UI: tracked revisions, comments and the hover card on a
 * revision in the document. The logic lives in `../../review`.
 *
 * The Docs shell (`../DocsWorkspace.tsx`, `../ReviewIntegration.tsx`) mounts the controller, the
 * shortcuts, comment clicks and the hover card beside the editor for the
 * life of a document, and shows `ReviewPanel` and `CommentsPanel` in its
 * Review tab:
 *
 * ```tsx
 * const [editor, setEditor] = useState<DocumentEditorController | null>(null);
 * const [surface, setSurface] = useState<HTMLDivElement | null>(null);
 * const review = useReviewController(session, editor);   // null on the first render
 * useReviewShortcuts(review);                              // Alt+Shift+N/P/A/R/M
 * useCommentClicks(review, surface);                       // click commented text: its thread becomes active
 *
 * <div ref={setSurface}><DocumentEditor session={session} ref={setEditor} /></div>
 * {review && <ReviewPanel controller={review} />}
 * {review && <CommentsPanel controller={review} />}
 * {review && <RevisionHoverCard controller={review} container={surface} />}
 * ```
 *
 * The components import `./review.css` themselves; it also styles the
 * editor highlight layers the controller paints (`review`, `comment-mark`).
 */

export { ReviewPanel, type ReviewPanelProps } from "./ReviewPanel";
export { CommentsPanel, type CommentsPanelProps } from "./CommentsPanel";
export { RevisionHoverCard, HOVER_HIDE_DELAY_MS, HOVER_SHOW_DELAY_MS, type RevisionHoverCardProps } from "./RevisionHoverCard";
export { ReviewFilters, type ReviewFiltersProps } from "./ReviewFilters";
export { RevisionList, type RevisionListProps } from "./RevisionList";
export { useCommentClicks, useEditorSurface, useReviewController, useReviewShortcuts, useReviewSnapshot } from "./use-review";
export { hoverTargetOf, placeCard } from "./hover-target";
