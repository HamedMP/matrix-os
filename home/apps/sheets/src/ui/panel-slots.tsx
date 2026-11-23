/// <reference types="vite/client" />
/**
 * The right panel's modules, built by other owners: the change review
 * (`ui/review/SheetReviewPanel` over the `review/` controller) and the
 * assistant (`ui/agent/SheetsAgentPanel` over the `agent/` assistant).
 *
 * Each loads lazily through `import.meta.glob`, so a build without the
 * modules still succeeds and shows a short fallback; `panel-adapters.tsx`
 * makes the review controller and the assistant for the open session. A
 * render error inside a panel shows the fallback instead of taking the app
 * down.
 */
import { Component, Suspense, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Bot, ListChecks } from "lucide-react";
import { EmptyState, Spinner } from "../../../_shared/office-ui";
import type { SheetGridController } from "../grid";
import type { SheetSession } from "../session/session";
import { type PanelModule, buildAgentPanel, buildReviewPanel, lazyFromModules } from "./panel-adapters";

/** Props the shell passes to `SheetReviewPanel` and `SheetsAgentPanel`. */
export interface SheetPanelProps {
  session: SheetSession;
  controller: SheetGridController;
  /** Closes the right panel. */
  onClose: () => void;
  /** Review only: the change to bring into view, for example one the assistant just proposed. */
  focusChangeId?: string | null;
  /** Assistant only: opens the review panel, at a change when one is given. */
  onOpenReview?: (changeId: string | null) => void;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A lazy component from the first matching module, or `fallback` when there is none. */
export function lazyPanel(modules: Record<string, () => Promise<PanelModule>>, exportName: string, fallback: ComponentType<SheetPanelProps>): ComponentType<SheetPanelProps> {
  return lazyFromModules(exportName, [modules], ([mod]) => {
    const candidate = (mod?.default ?? mod?.[exportName]) as ComponentType<SheetPanelProps> | undefined;
    return typeof candidate === "function" || (typeof candidate === "object" && candidate !== null) ? candidate : null;
  }, fallback);
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

const ReviewImpl = lazyFromModules(
  "SheetReviewPanel",
  [import.meta.glob<PanelModule>("./review/index.ts"), import.meta.glob<PanelModule>("../review/index.ts")],
  buildReviewPanel,
  ReviewFallback,
);
const AgentImpl = lazyFromModules(
  "SheetsAgentPanel",
  [import.meta.glob<PanelModule>("./agent/index.ts"), import.meta.glob<PanelModule>("../agent/index.ts")],
  buildAgentPanel,
  AgentFallback,
);

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
