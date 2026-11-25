/**
 * The right panel: Review, Assistant and Compare tabs. Review renders the
 * review module's panels around the controller the workspace creates; the
 * Assistant and Compare panels are split into their own chunks and loaded on
 * first use. A load or render failure shows a fallback instead of breaking
 * the app.
 */

import { GitCompareArrows, ListChecks, Sparkles, X } from "lucide-react";
import { Component, type ComponentType, type ErrorInfo, type ReactNode, Suspense, lazy } from "react";
import { EmptyState, Spinner, Tabs } from "../../../_shared/office-ui";
import type { ReviewController } from "../review/index";
import type { AssistantStore } from "./agent/assistant-store";
import type { DocumentSlot } from "./document-slot";
import type { AssistantRequest, DocsPanelId, DocsPanelProps } from "./panel-types";
import { ReviewTab } from "./ReviewIntegration";

/** Extra props every panel receives besides `DocsPanelProps`. */
export interface ShellPanelProps extends DocsPanelProps {
  /** The review controller of the open document; null until it is ready. */
  review: ReviewController | null;
  /** True in the read-only (original) view. */
  readOnly: boolean;
  /** A ribbon request for the Assistant panel; it reports it handled once it ran (or cannot run). */
  assistantRequest?: AssistantRequest | null;
  onAssistantRequestHandled?: () => void;
  /** The Assistant's conversation for the open document, kept while its tab is hidden or the panel closed. */
  assistantSlot?: DocumentSlot<AssistantStore>;
  /** The ribbon asked for a new comment: the Review tab focuses its comment box. */
  composeComment?: boolean;
  onComposeHandled?: () => void;
}

const PANELS: ReadonlyArray<{ id: DocsPanelId; label: string; icon: ReactNode }> = [
  { id: "review", label: "Review", icon: <ListChecks size={14} /> },
  { id: "assistant", label: "Assistant", icon: <Sparkles size={14} /> },
  { id: "compare", label: "Compare", icon: <GitCompareArrows size={14} /> },
];

const LOADED: Record<DocsPanelId, ComponentType<ShellPanelProps>> = {
  review: ReviewTab,
  assistant: lazy(() => import("./agent/DocsAgentPanel")),
  compare: lazy(() => import("./compare/ComparePanel")),
};

class PanelBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("docs: a side panel failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) return <EmptyState headline="This panel stopped working" description="Your document is not affected. Switch tabs or reopen the panel." />;
    return this.props.children;
  }
}

export interface SidePanelsProps extends ShellPanelProps {
  active: DocsPanelId;
  onChange: (id: DocsPanelId) => void;
  /** Replaces the loaded panels, for tests. */
  panels?: Partial<Record<DocsPanelId, ComponentType<ShellPanelProps>>>;
}

export function SidePanels({ active, onChange, panels, ...panelProps }: SidePanelsProps) {
  const ActivePanel = panels?.[active] ?? LOADED[active];
  return (
    <div className="docs-side">
      <Tabs
        label="Side panel"
        tabs={PANELS.map((panel) => ({ id: panel.id, label: panel.label, icon: panel.icon }))}
        activeId={active}
        onChange={(id) => onChange(id as DocsPanelId)}
        trailing={
          <button type="button" className="oui-icon-button" aria-label="Close side panel" title="Close side panel" onClick={panelProps.onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        }
        renderPanel={() => (
          <PanelBoundary resetKey={active}>
            <Suspense fallback={<Spinner label="Loading panel" />}>
              <ActivePanel {...panelProps} />
            </Suspense>
          </PanelBoundary>
        )}
      />
    </div>
  );
}
