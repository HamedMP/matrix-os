import { useEffect, useRef, useState } from "react";
import { TerminalAttentionCard, retainTerminalAttention, terminalAttentionChanges,
  type TerminalAttention, type TerminalTabFacts } from "@matrix-os/ui/terminal-agents";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { LocalTerminalsState } from "./use-local-terminals";

/** Poll snapshots use the same transitions, in-place updates and copy as the web. */
export function LocalTerminalAttention({ state, activeId, onOpen }: {
  state: LocalTerminalsState; activeId: string | null; onOpen(id: string): void;
}) {
  const previous = useRef<ReadonlyMap<string, TerminalTabFacts> | null>(null);
  const [alerts, setAlerts] = useState<TerminalAttention[]>([]);
  useEffect(() => {
    if (state.status !== "ready") { previous.current = null; return; }
    const next = new Map<string, TerminalTabFacts>(state.terminals.map(terminal => [`local:${terminal.id}`, {
      ref: { workspaceId: "local", tabId: terminal.id }, name: terminal.title, cwd: "", state: "live",
      agentStatus: terminal.status ?? undefined, statusMessage: terminal.statusMessage,
    }]));
    const before = previous.current;
    previous.current = next;
    const seen = new Set<string>();
    if (activeId && document.visibilityState === "visible" && document.hasFocus()) seen.add(`local:${activeId}`);
    const changes = before ? terminalAttentionChanges(before, next, seen) : [];
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-adjust-state-on-prop-change -- external trusted-core snapshots drive transient notifications; they cannot be derived from the current snapshot alone because dismissed alerts and transition history matter.
    setAlerts(current => {
      const kept = retainTerminalAttention(current, next);
      const updated = [...changes.filter(change => !kept.some(alert => alert.key === change.key)), ...kept].slice(0, 32);
      return JSON.stringify(current) === JSON.stringify(updated) ? current : updated;
    });
  }, [state, activeId]);
  useEffect(() => {
    if (!alerts.some(alert => alert.kind === "done")) return;
    const timer = setTimeout(() => setAlerts(current => current.filter(alert => alert.kind !== "done")), 12_000);
    return () => clearTimeout(timer);
  }, [alerts]);
  const dismiss = (key: string) => setAlerts(current => current.filter(alert => alert.key !== key));
  return <div className="pointer-events-none fixed right-4 top-12 flex flex-col gap-2" style={{ zIndex: DESKTOP_Z_INDEX.popover }}>
    {alerts.toSorted((a, b) => Number(a.kind === "done") - Number(b.kind === "done")).slice(0, 3).map(alert =>
      <TerminalAttentionCard key={alert.key} alert={alert} onOpen={() => { onOpen(alert.ref.tabId); dismiss(alert.key); }} onDismiss={() => dismiss(alert.key)} />)}
  </div>;
}
