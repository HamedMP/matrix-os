/**
 * Slot for the calendar agent panel (`CalendarAgentPanel` from `./agent`,
 * built separately). It is loaded lazily; when the module is absent or fails
 * to load, a short notice takes its place.
 */
import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { Bot, X } from "lucide-react";
import { EmptyState, Spinner } from "../../../_shared/office-ui";
import type { AgentSlotPanelProps } from "./agentSlotTypes";

type PanelModule = { CalendarAgentPanel?: ComponentType<AgentSlotPanelProps> };

const modules = import.meta.glob<PanelModule>("./agent/index.ts");
const loader = modules["./agent/index.ts"];
const LazyPanel = loader
  ? lazy(async () => {
    const module = await loader();
    if (!module.CalendarAgentPanel) throw new Error("CalendarAgentPanel export missing");
    return { default: module.CalendarAgentPanel };
  })
  : null;

class PanelBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn("[calendar] agent panel failed", error instanceof Error ? error.name : typeof error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Unavailable({ onClose }: { onClose(): void }) {
  return (
    <div className="cal-agent-fallback">
      <div className="cal-composer__head">
        <h2>Agent</h2>
        <button type="button" className="oui-icon-button" aria-label="Close agent" onClick={onClose}><X size={16} /></button>
      </div>
      <EmptyState icon={<Bot />} headline="Agent not available" description="The calendar agent could not be loaded here. Proposals it writes still appear on the grid." />
    </div>
  );
}

/** True when this build includes the agent panel module. */
export const AGENT_PANEL_AVAILABLE = LazyPanel !== null;

export interface AgentSlotProps extends AgentSlotPanelProps {
  onClose(): void;
}

export function AgentSlot(props: AgentSlotProps) {
  if (!LazyPanel) return <Unavailable onClose={props.onClose} />;
  return (
    <PanelBoundary fallback={<Unavailable onClose={props.onClose} />}>
      <Suspense fallback={<div className="cal-agent-fallback"><Spinner label="Loading agent" /></div>}>
        <LazyPanel {...props} />
      </Suspense>
    </PanelBoundary>
  );
}
