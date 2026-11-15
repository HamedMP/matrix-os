import { useMemo } from "react";
import { TerminalAttentionCard, useTerminalAttention, visibleTerminalSessions } from "@matrix-os/ui/terminal-agents";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useTerminalAgentEvents } from "../../stores/terminal-agent-events";
import { openTerminalSession } from "../mission-control/navigation-roots";

/**
 * Attention toasts for Matrix-computer terminal tabs in the Electron main window:
 * the same transitions, copy and card as Web Canvas and Web Desktop. Open focuses
 * that tab in the Terminal app.
 */
export function RemoteTerminalAttention() {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const connected = useTerminalAgentEvents((state) => state.connected);
  // Until a snapshot arrives nothing is known; after a reconnect it is a fresh baseline.
  const facts = useMemo(() => (connected ? new Map(Object.entries(tabs)) : null), [tabs, connected]);
  const { visible, dismiss } = useTerminalAttention(facts, visibleTerminalSessions);
  if (visible.length === 0) return null;
  return <div className="pointer-events-none fixed right-4 top-12 flex flex-col gap-2" style={{ zIndex: DESKTOP_Z_INDEX.popover }}>
    {visible.map((alert) =>
      <TerminalAttentionCard key={alert.key} alert={alert}
        onOpen={() => { openTerminalSession(alert.key); dismiss(alert.key); }} onDismiss={() => dismiss(alert.key)} />)}
  </div>;
}
