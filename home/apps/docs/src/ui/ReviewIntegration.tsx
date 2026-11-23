/**
 * The review module's components in the shell: the document layer (review
 * shortcuts, clicks on commented text, the hover card on revisions) and the
 * Review tab (revisions and comments). Both load lazily and render a
 * fallback, or nothing, without the review modules.
 */

import { type ComponentType, Suspense, lazy } from "react";
import { EmptyState, Spinner } from "../../../_shared/office-ui";
import type { DocsPanelProps } from "./panel-types";
import { REVIEW_AVAILABLE, type ReviewControllerHandle, loadReviewModules } from "./review-integration";

interface LayerProps {
  controller: ReviewControllerHandle;
  container: HTMLElement | null;
  readOnly: boolean;
}

const LazyLayer = lazy(async (): Promise<{ default: ComponentType<LayerProps> }> => {
  const modules = await loadReviewModules();
  if (modules === null) return { default: () => null };
  const { useReviewShortcuts, useCommentClicks, RevisionHoverCard } = modules;
  function ReviewLayer({ controller, container, readOnly }: LayerProps) {
    useReviewShortcuts(controller);
    useCommentClicks(controller, container);
    return <RevisionHoverCard controller={controller} container={container} disabled={readOnly} />;
  }
  return { default: ReviewLayer };
});

/** Mounted beside the editor while a document is open. */
export function ReviewDocumentLayer({ controller, container, readOnly }: { controller: ReviewControllerHandle | null; container: HTMLElement | null; readOnly: boolean }) {
  if (controller === null) return null;
  return (
    <Suspense fallback={null}>
      <LazyLayer controller={controller} container={container} readOnly={readOnly} />
    </Suspense>
  );
}

const LazyTab = lazy(async (): Promise<{ default: ComponentType<{ controller: ReviewControllerHandle; busy: boolean }> }> => {
  const modules = await loadReviewModules();
  if (modules === null) return { default: () => <EmptyState headline="Not available" description="Revision and comment review could not be loaded." /> };
  const { ReviewPanel, CommentsPanel } = modules;
  function ReviewTabContent({ controller, busy }: { controller: ReviewControllerHandle; busy: boolean }) {
    return (
      <div className="docs-review-tab">
        <ReviewPanel controller={controller} busy={busy} />
        <CommentsPanel controller={controller} busy={busy} />
      </div>
    );
  }
  return { default: ReviewTabContent };
});

/** The Review tab: revisions and comments of the open document. */
export function ReviewTab({ review, readOnly }: DocsPanelProps & { review: unknown; readOnly: boolean }) {
  if (!REVIEW_AVAILABLE) return <EmptyState headline="Not available" description="Revision and comment review is not available in this build." />;
  if (review === null || review === undefined) return <Spinner label="Loading review" />;
  return (
    <Suspense fallback={<Spinner label="Loading review" />}>
      <LazyTab controller={review as ReviewControllerHandle} busy={readOnly} />
    </Suspense>
  );
}
