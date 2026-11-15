import { useMemo } from "react";
import { TerminalAttentionCard, useTerminalAttention, type TerminalTabFacts } from "@matrix-os/ui/terminal-agents";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { LocalTerminalsState } from "./use-local-terminals";

/** Poll snapshots use the same transitions, in-place updates and copy as the web. */
export function LocalTerminalAttention({ state, activeId, onOpen }: {
  state: LocalTerminalsState; activeId: string | null; onOpen(id: string): void;
}) {
  const facts = useMemo(() => state.status !== "ready" ? null : new Map<string, TerminalTabFacts>(state.terminals.map(terminal => [`local:${terminal.id}`, {
    ref: { workspaceId: "local", tabId: terminal.id }, name: terminal.title, cwd: "", state: "live",
    agentStatus: terminal.status ?? undefined, statusMessage: terminal.statusMessage,
  }])), [state]);
  const seen = () => new Set(activeId && document.visibilityState === "visible" && document.hasFocus() ? [`local:${activeId}`] : []);
  const { visible, dismiss } = useTerminalAttention(facts, seen);
  return <div className="pointer-events-none fixed right-4 top-12 flex flex-col gap-2" style={{ zIndex: DESKTOP_Z_INDEX.popover }}>
    {visible.map(alert =>
      <TerminalAttentionCard key={alert.key} alert={alert} onOpen={() => { onOpen(alert.ref.tabId); dismiss(alert.key); }} onDismiss={() => dismiss(alert.key)} />)}
  </div>;
}
