import { useMemo } from "react";
import { useTerminalAttention, visibleTerminalSessions } from "@matrix-os/ui/terminal-agents";
import { useTerminalAgentEvents } from "../../stores/terminal-agent-events";
import { openTerminalSession } from "../mission-control/navigation-roots";
import { useTerminalAttentionToasts } from "./use-terminal-attention-toasts";

/**
 * Attention toasts for Matrix-computer terminal tabs in the Electron main window:
 * the same transitions, copy and card as Web Canvas and Web Desktop. Open focuses
 * that tab in the Terminal app.
 */
export function RemoteTerminalAttention(): null {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const connected = useTerminalAgentEvents((state) => state.connected);
  // Until a snapshot arrives nothing is known; after a reconnect it is a fresh baseline.
  const facts = useMemo(() => (connected ? new Map(Object.entries(tabs)) : null), [tabs, connected]);
  const { visible, dismiss } = useTerminalAttention(facts, visibleTerminalSessions);
  // Cards go through the main window's toast host (App's Toaster), like other notices.
  useTerminalAttentionToasts(visible, (alert) => openTerminalSession(alert.key), dismiss);
  return null;
}
