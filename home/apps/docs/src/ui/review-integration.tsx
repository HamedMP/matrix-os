/// <reference types="vite/client" />
/**
 * Wires the review module (`./review/index.ts`, owned elsewhere) into the
 * shell when it is part of the build: one review controller per session,
 * its keyboard shortcuts, clicks on commented text and the hover card on
 * revisions in the document (`ReviewDocumentLayer`, always mounted), and the
 * Review tab content (`ReviewTab`). Without the module both render fallbacks.
 */

import { type ComponentType, Suspense, lazy, useEffect } from "react";
import { EmptyState, Spinner } from "../../../_shared/office-ui";
import type { DocumentEditorController } from "../editor/index";
import type { DocumentSession } from "../session/index";
import type { DocsPanelProps } from "./panel-types";

type Loader = () => Promise<Record<string, unknown>>;

const REVIEW_MODULE: Loader | undefined = Object.values(import.meta.glob<Record<string, unknown>>("./review/index.ts"))[0];

/** The parts of the review module the shell uses. The controller stays opaque here. */
interface ReviewModule {
  useReviewController(session: DocumentSession, editor: DocumentEditorController | null): unknown;
  useReviewShortcuts(controller: unknown): void;
  useCommentClicks(controller: unknown, container: HTMLElement | null): void;
  RevisionHoverCard: ComponentType<{ controller: unknown; container: HTMLElement | null; disabled?: boolean }>;
  ReviewPanel: ComponentType<{ controller: unknown; busy?: boolean }>;
  CommentsPanel: ComponentType<{ controller: unknown; busy?: boolean }>;
}

function isReviewModule(value: Record<string, unknown>): value is Record<string, unknown> & ReviewModule {
  return ["useReviewController", "useReviewShortcuts", "useCommentClicks", "RevisionHoverCard", "ReviewPanel", "CommentsPanel"].every((name) => value[name] !== undefined);
}

let loading: Promise<ReviewModule | null> | null = null;

/** Loads the review module once; null when it is absent or unusable. */
export function loadReviewModule(loader: Loader | undefined = REVIEW_MODULE): Promise<ReviewModule | null> {
  if (loader === undefined) return Promise.resolve(null);
  if (loader === REVIEW_MODULE && loading !== null) return loading;
  const attempt = loader().then(
    (module) => {
      if (isReviewModule(module)) return module;
      console.warn("docs: the review module does not export what the shell needs");
      return null;
    },
    (error: unknown) => {
      console.warn("docs: could not load the review module", error);
      return null;
    },
  );
  if (loader === REVIEW_MODULE) loading = attempt;
  return attempt;
}

export interface ReviewLayerProps {
  session: DocumentSession;
  editor: DocumentEditorController | null;
  container: HTMLElement | null;
  readOnly: boolean;
  /** Receives the review controller (or null) for the Review tab. */
  onController: (controller: unknown) => void;
}

const NoLayer: ComponentType<ReviewLayerProps> = () => null;

const LazyLayer = lazy(async (): Promise<{ default: ComponentType<ReviewLayerProps> }> => {
  const module = await loadReviewModule();
  if (module === null) return { default: NoLayer };
  function ReviewLayer({ session, editor, container, readOnly, onController }: ReviewLayerProps) {
    const controller = module!.useReviewController(session, editor);
    module!.useReviewShortcuts(controller);
    module!.useCommentClicks(controller, container);
    useEffect(() => {
      onController(controller);
      return () => onController(null);
    }, [controller, onController]);
    if (controller === null) return null;
    const Card = module!.RevisionHoverCard;
    return <Card controller={controller} container={container} disabled={readOnly} />;
  }
  return { default: ReviewLayer };
});

/** Mounted beside the editor for the life of a document. Renders nothing without the review module. */
export function ReviewDocumentLayer(props: ReviewLayerProps) {
  if (REVIEW_MODULE === undefined) return null;
  return (
    <Suspense fallback={null}>
      <LazyLayer {...props} />
    </Suspense>
  );
}

const LazyTab = lazy(async (): Promise<{ default: ComponentType<{ controller: unknown; busy: boolean }> }> => {
  const module = await loadReviewModule();
  if (module === null) return { default: () => <EmptyState headline="Not available" description="Revision and comment review could not be loaded." /> };
  function ReviewTabContent({ controller, busy }: { controller: unknown; busy: boolean }) {
    const Panel = module!.ReviewPanel;
    const Comments = module!.CommentsPanel;
    return (
      <div className="docs-review-tab">
        <Panel controller={controller} busy={busy} />
        <Comments controller={controller} busy={busy} />
      </div>
    );
  }
  return { default: ReviewTabContent };
});

/** The Review tab: revisions and comments of the open document. */
export function ReviewTab({ review, readOnly }: DocsPanelProps & { review?: unknown; readOnly?: boolean }) {
  if (REVIEW_MODULE === undefined) return <EmptyState headline="Not available" description="Revision and comment review is not available in this build." />;
  if (review === null || review === undefined) return <Spinner label="Loading review" />;
  return (
    <Suspense fallback={<Spinner label="Loading review" />}>
      <LazyTab controller={review} busy={readOnly === true} />
    </Suspense>
  );
}
