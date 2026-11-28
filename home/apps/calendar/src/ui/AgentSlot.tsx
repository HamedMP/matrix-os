/**
 * Slot for the calendar agent panel (`CalendarAgentPanel` from `./agent`).
 * It is part of the app's one JavaScript file: the app frame is sandboxed with
 * a null origin and refuses a chunk loaded later. When the panel fails to
 * render, a short notice takes its place.
 */
import { Component, type ReactNode } from "react";
import { Bot, X } from "lucide-react";
import { EmptyState } from "../../../_shared/office-ui";
import { CalendarAgentPanel } from "./agent";
import type { AgentSlotPanelProps } from "./agentSlotTypes";

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

export interface AgentSlotProps extends AgentSlotPanelProps {
  onClose(): void;
}

export function AgentSlot(props: AgentSlotProps) {
  return (
    <PanelBoundary fallback={<Unavailable onClose={props.onClose} />}>
      <CalendarAgentPanel {...props} />
    </PanelBoundary>
  );
}
