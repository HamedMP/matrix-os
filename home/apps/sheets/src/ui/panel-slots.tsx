/// <reference types="vite/client" />
/**
 * The right panel's modules, built by other owners: the change review
 * (`ui/review/SheetReviewPanel` over the `review/` controller) and the
 * assistant (`ui/agent/SheetsAgentPanel.tsx`).
 *
 * Each loads lazily through `import.meta.glob`, so a build without the
 * module still succeeds and shows a short fallback. The assistant module may
 * export its component as `default` or as `SheetsAgentPanel`; it receives
 * {@link SheetPanelProps}. A render error inside a panel shows the fallback
 * instead of taking the app down.
 */
import { Component, lazy, Suspense, useEffect, useMemo, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Bot, ListChecks } from "lucide-react";
import { EmptyState, Spinner } from "../../../_shared/office-ui";
import type { SheetGridController } from "../grid";
import type { SheetSession } from "../session/session";
import { logFailure } from "./bridge";

/** Props the shell passes to `SheetReviewPanel` and `SheetsAgentPanel`. */
export interface SheetPanelProps {
  session: SheetSession;
  controller: SheetGridController;
  /** Closes the right panel. */
  onClose: () => void;
}

type PanelModule = Record<string, unknown>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A lazy component from the first matching module, or `fallback` when there is none. */
export function lazyPanel(modules: Record<string, () => Promise<PanelModule>>, exportName: string, fallback: ComponentType<SheetPanelProps>): ComponentType<SheetPanelProps> {
  const loader = Object.values(modules)[0];
  if (loader === undefined) return fallback;
  return lazy(async () => {
    try {
      const mod = await loader();
      const candidate = (mod.default ?? mod[exportName]) as ComponentType<SheetPanelProps> | undefined;
      return { default: typeof candidate === "function" || (typeof candidate === "object" && candidate !== null) ? candidate : fallback };
    } catch (error: unknown) {
      console.warn(`[sheets] panel.load.failed (${exportName}, ${errorName(error)})`);
      return { default: fallback };
    }
  });
}

class PanelBoundary extends Component<{ name: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    console.warn(`[sheets] panel.render.failed (${this.props.name}, ${errorName(error)})`);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ReviewFallback({ onClose }: SheetPanelProps) {
  return (
    <div className="sheets-panel-fallback">
      <EmptyState
        icon={<ListChecks />}
        headline="Change review is not available"
        description="This build of Sheets does not include the review panel. Cells with proposed changes are still tinted in the grid."
        action={{ label: "Close", onClick: onClose }}
      />
    </div>
  );
}

function AgentFallback({ onClose }: SheetPanelProps) {
  return (
    <div className="sheets-panel-fallback">
      <EmptyState
        icon={<Bot />}
        headline="The assistant is not available"
        description="This build of Sheets does not include the assistant panel."
        action={{ label: "Close", onClick: onClose }}
      />
    </div>
  );
}

interface ReviewControllerLike {
  dispose(): void;
}
type ReviewControllerClass = new (session: SheetSession, grid: SheetGridController, log: (message: string, error: unknown) => void) => ReviewControllerLike;
type ReviewPanelComponent = ComponentType<{ review: ReviewControllerLike; onClose?: () => void }>;

/** The panel component over a review controller made for the session and grid it is given. */
function reviewAdapter(Panel: ReviewPanelComponent, Controller: ReviewControllerClass): ComponentType<SheetPanelProps> {
  return function ReviewAdapter({ session, controller: grid, onClose }: SheetPanelProps) {
    const review = useMemo(() => new Controller(session, grid, logFailure), [session, grid]);
    useEffect(() => () => review.dispose(), [review]);
    return <Panel review={review} onClose={onClose} />;
  };
}

/** Builds the review panel from the review controller (`../review`) and its view (`./review`). */
export function lazyReviewPanel(
  views: Record<string, () => Promise<PanelModule>>,
  controllers: Record<string, () => Promise<PanelModule>>,
  fallback: ComponentType<SheetPanelProps>,
): ComponentType<SheetPanelProps> {
  const loadView = Object.values(views)[0];
  const loadController = Object.values(controllers)[0];
  if (loadView === undefined || loadController === undefined) return fallback;
  return lazy(async () => {
    try {
      const [view, controller] = await Promise.all([loadView(), loadController()]);
      const Panel = view.SheetReviewPanel as ReviewPanelComponent | undefined;
      const Controller = controller.SheetReviewController as ReviewControllerClass | undefined;
      if (typeof Panel !== "function" || typeof Controller !== "function") return { default: fallback };
      return { default: reviewAdapter(Panel, Controller) };
    } catch (error: unknown) {
      console.warn(`[sheets] panel.load.failed (SheetReviewPanel, ${errorName(error)})`);
      return { default: fallback };
    }
  });
}

const ReviewImpl = lazyReviewPanel(import.meta.glob<PanelModule>("./review/index.ts"), import.meta.glob<PanelModule>("../review/index.ts"), ReviewFallback);
const AgentImpl = lazyPanel(import.meta.glob<PanelModule>("./agent/SheetsAgentPanel.tsx"), "SheetsAgentPanel", AgentFallback);

const loading = (
  <div className="sheets-panel-loading">
    <Spinner size={16} label="Loading panel" />
  </div>
);

export function ReviewPanelSlot(props: SheetPanelProps) {
  return (
    <PanelBoundary name="SheetReviewPanel" fallback={<ReviewFallback {...props} />}>
      <Suspense fallback={loading}>
        <ReviewImpl {...props} />
      </Suspense>
    </PanelBoundary>
  );
}

export function AgentPanelSlot(props: SheetPanelProps) {
  return (
    <PanelBoundary name="SheetsAgentPanel" fallback={<AgentFallback {...props} />}>
      <Suspense fallback={loading}>
        <AgentImpl {...props} />
      </Suspense>
    </PanelBoundary>
  );
}
