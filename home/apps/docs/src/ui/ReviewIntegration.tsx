/**
 * The review module's components in the shell: the document layer (review
 * shortcuts, clicks on commented text, the hover card on revisions) and the
 * Review tab (revisions and comments). The controller itself comes from
 * `useReviewController` in `./review`, created once per session by the
 * workspace.
 */

import { Spinner } from "../../../_shared/office-ui";
import type { ReviewController } from "../review/index";
import type { ShellPanelProps } from "./SidePanels";
import { CommentsPanel, ReviewPanel, RevisionHoverCard, useCommentClicks, useReviewShortcuts } from "./review/index";

interface LayerProps {
  controller: ReviewController | null;
  container: HTMLElement | null;
  readOnly: boolean;
}

/**
 * Mounted beside the editor while a document is open. In a read-only view
 * the controller itself refuses every change, so the shortcuts keep only
 * next and previous.
 */
export function ReviewDocumentLayer({ controller, container, readOnly }: LayerProps) {
  useReviewShortcuts(controller);
  useCommentClicks(controller, container);
  if (controller === null) return null;
  return <RevisionHoverCard controller={controller} container={container} disabled={readOnly} />;
}

/** The Review tab: revisions and comments of the open document. */
export function ReviewTab({ review, readOnly, composeComment = false, onComposeHandled }: ShellPanelProps) {
  if (review === null) return <Spinner label="Loading review" />;
  return (
    <div className="docs-review-tab">
      <ReviewPanel controller={review} busy={readOnly} />
      <CommentsPanel controller={review} busy={readOnly} focusComposer={composeComment} onComposerFocused={onComposeHandled} />
    </div>
  );
}
