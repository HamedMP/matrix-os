/// <reference types="vite/client" />
/**
 * The right panel: Review, Assistant and Compare tabs. Their content comes
 * from modules other engineers own, loaded lazily; a missing module or a
 * load or render failure shows a fallback instead of breaking the app.
 * Review is wired through `./review-integration.tsx`, which needs the review
 * controller the workspace creates.
 */

import { GitCompareArrows, ListChecks, Sparkles, X } from "lucide-react";
import { Component, type ComponentType, type ErrorInfo, type ReactNode, Suspense, lazy } from "react";
import { EmptyState, Spinner, Tabs } from "../../../_shared/office-ui";
import type { DocsPanelId, DocsPanelProps } from "./panel-types";
import { ReviewTab } from "./review-integration";

type PanelModule = Record<string, unknown>;
type Loader = () => Promise<PanelModule>;

// Literal patterns: Vite resolves them at build time and leaves out files that do not exist.
const MODULES: Record<string, Loader> = {
  ...import.meta.glob<PanelModule>("./agent/DocsAgentPanel.tsx"),
  ...import.meta.glob<PanelModule>("./compare/ComparePanel.tsx"),
};

interface PanelSpec {
  id: DocsPanelId;
  label: string;
  icon: ReactNode;
  path: string;
  exportName: string;
  missing: string;
}

const PANELS: readonly PanelSpec[] = [
  { id: "review", label: "Review", icon: <ListChecks size={14} />, path: "./review/ReviewPanel.tsx", exportName: "ReviewPanel", missing: "Revision and comment review is not available in this build." },
  { id: "assistant", label: "Assistant", icon: <Sparkles size={14} />, path: "./agent/DocsAgentPanel.tsx", exportName: "DocsAgentPanel", missing: "The document assistant is not available in this build." },
  { id: "compare", label: "Compare", icon: <GitCompareArrows size={14} />, path: "./compare/ComparePanel.tsx", exportName: "ComparePanel", missing: "Comparing documents is not available in this build." },
];

function fallback<P>(message: string): ComponentType<P> {
  return function PanelFallback() {
    return <EmptyState headline="Not available" description={message} />;
  };
}

/** A lazy component for a panel module, or a fallback when the module is absent, fails to load or exports no component. */
export function createPanelLoader<P extends DocsPanelProps = DocsPanelProps>(modules: Readonly<Record<string, Loader>>, path: string, exportName: string, missing: string): ComponentType<P> {
  const load = modules[path];
  if (load === undefined) return fallback<P>(missing);
  return lazy(async () => {
    try {
      const module = await load();
      const component = module.default ?? module[exportName];
      if (typeof component === "function" || (typeof component === "object" && component !== null)) return { default: component as ComponentType<P> };
      console.warn(`docs: ${path} exports no panel component`);
    } catch (error) {
      console.warn(`docs: could not load ${path}`, error);
    }
    return { default: fallback<P>("This panel could not be loaded. Reopen Docs to try again.") };
  });
}

/** Extra props every panel receives besides `DocsPanelProps`. */
export interface ShellPanelProps extends DocsPanelProps {
  /** The review controller of `./review`, opaque here; null until it is ready. */
  review: unknown;
  /** True in the read-only (original) view. */
  readOnly: boolean;
}

function loaderFor(id: DocsPanelId): ComponentType<ShellPanelProps> {
  const panel = PANELS.find((spec) => spec.id === id)!;
  return createPanelLoader<ShellPanelProps>(MODULES, panel.path, panel.exportName, panel.missing);
}

const LOADED: Record<DocsPanelId, ComponentType<ShellPanelProps>> = {
  review: ReviewTab,
  assistant: loaderFor("assistant"),
  compare: loaderFor("compare"),
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
