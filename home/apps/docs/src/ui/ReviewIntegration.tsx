/**
 * The review module's components in the shell: the document layer (review
 * shortcuts, clicks on commented text, the hover card on revisions) and the
 * Review tab (revisions and comments). The controller itself comes from
 * `useReviewController` in `./review`, created once per session by the
 * workspace.
 */

import { Spinner } from "../../../_shared/office-ui";
import { useSessionState } from "../editor/index";
import type { ReviewController } from "../review/index";
import type { ShellPanelProps } from "./SidePanels";
import { CommentsPanel, ReviewPanel, RevisionHoverCard, useCommentClicks, useReviewShortcuts } from "./review/index";

interface LayerProps {
  controller: ReviewController | null;
  container: HTMLElement | null;
  readOnly: boolean;
  /** The workspace's New comment action: it opens the Review tab and focuses the comment box. */
  onRequestComment?: () => void;
}

/**
 * Mounted beside the editor while a document is open. In a read-only view
 * the controller itself refuses every change, so the shortcuts keep only
 * next and previous.
 */
export function ReviewDocumentLayer({ controller, container, readOnly, onRequestComment }: LayerProps) {
  useReviewShortcuts(controller, { onComment: onRequestComment });
  useCommentClicks(controller, container);
  if (controller === null) return null;
  return <RevisionHoverCard controller={controller} container={container} disabled={readOnly} />;
}

/**
 * The Review tab: revisions and comments of the open document. It starts
 * afresh for every document (keyed by it), so a comment or reply drafted for
 * one is never sent to the next.
 */
export function ReviewTab({ session, review, readOnly, composeComment = false, onComposeHandled }: ShellPanelProps) {
  const { documentKey } = useSessionState(session);
  if (review === null) return <Spinner label="Loading review" />;
  return (
    <div key={documentKey} className="docs-review-tab">
      <ReviewPanel controller={review} busy={readOnly} />
      <CommentsPanel controller={review} busy={readOnly} focusComposer={composeComment} onComposerFocused={onComposeHandled} />
    </div>
  );
}
