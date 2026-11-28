/**
 * The right panel: change review (`ui/review` over the `review/` controller)
 * and the assistant (`ui/agent` over the `agent/` assistant).
 *
 * `useSheetPanels` makes one review controller and one assistant per open
 * workbook, so the review position and the assistant conversation survive
 * switching or closing the panel. A render error inside a panel shows a
 * short notice instead of taking the app down.
 */
import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { EmptyState } from "../../../_shared/office-ui";
import { SheetsAssistant, type SheetsAi } from "../agent";
import type { SheetGridController } from "../grid";
import { SheetReviewController } from "../review";
import type { SheetSession } from "../session/session";
import { SheetsAgentPanel, selectionFromGrid } from "./agent";
import { logFailure } from "./bridge";
import { SheetReviewPanel } from "./review";

export interface SheetPanels {
  review: SheetReviewController;
  assistant: SheetsAssistant;
}

/**
 * The review controller and assistant of one workbook. `onReview` runs when
 * the assistant asks to show its proposal, with the first changed cell.
 */
export function useSheetPanels(session: SheetSession, grid: SheetGridController, ai: SheetsAi | null, onReview: (changeId: string | null) => void): SheetPanels {
  const review = useMemo(() => new SheetReviewController(session, grid, logFailure), [session, grid]);
  // StrictMode sets effects up, cleans them up and sets them up again with the same objects: attach in the setup.
  useEffect(() => {
    review.attach();
    return () => review.dispose();
  }, [review]);
  const assistant = useMemo(
    () =>
      new SheetsAssistant({
        session,
        ai,
        grid,
        log: logFailure,
        onReview: (_proposalId, changeId) => {
          if (changeId !== null) review.goTo(changeId);
          onReview(changeId);
        },
      }),
    [session, ai, grid, review, onReview],
  );
  useEffect(() => {
    assistant.attach();
    return () => assistant.dispose();
  }, [assistant]);
  return { review, assistant };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

class PanelBoundary extends Component<{ name: string; onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    console.warn(`[sheets] panel.render.failed (${this.props.name}, ${errorName(error)})`);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="sheets-panel-fallback">
        <EmptyState
          icon={<AlertTriangle />}
          headline="This panel stopped working"
          description="Your workbook is not affected. Close the panel and open it again."
          action={{ label: "Close", onClick: this.props.onClose }}
        />
      </div>
    );
  }
}

export function ReviewPanelSlot({ review, onClose }: { review: SheetReviewController; onClose: () => void }) {
  return (
    <PanelBoundary name="SheetReviewPanel" onClose={onClose}>
      <SheetReviewPanel review={review} onClose={onClose} />
    </PanelBoundary>
  );
}

export interface AgentPanelSlotProps {
  assistant: SheetsAssistant;
  grid: SheetGridController;
  aiAvailable: boolean;
  /** Why the assistant is off, shown when `aiAvailable` is false. */
  unavailableMessage?: string;
  onClose: () => void;
}

export function AgentPanelSlot({ assistant, grid, aiAvailable, unavailableMessage, onClose }: AgentPanelSlotProps) {
  return (
    <PanelBoundary name="SheetsAgentPanel" onClose={onClose}>
      <SheetsAgentPanel assistant={assistant} getSelection={() => selectionFromGrid(grid)} beforeAction={() => grid.commitEdit()} onClose={onClose} aiAvailable={aiAvailable} unavailableMessage={unavailableMessage} />
    </PanelBoundary>
  );
}
