import { useMemo } from "react";
import { useTerminalAttention, type TerminalTabFacts } from "@matrix-os/ui/terminal-agents";
import { useTerminalAttentionToasts } from "../terminal/use-terminal-attention-toasts";
import type { LocalTerminalsState } from "./use-local-terminals";

/** Poll snapshots use the same transitions, in-place updates and copy as the web. */
export function LocalTerminalAttention({ state, activeId, onOpen }: {
  state: LocalTerminalsState; activeId: string | null; onOpen(id: string): void;
}): null {
  const facts = useMemo(() => state.status !== "ready" ? null : new Map<string, TerminalTabFacts>(state.terminals.map(terminal => [`local:${terminal.id}`, {
    ref: { workspaceId: "local", tabId: terminal.id }, name: terminal.title, cwd: "", state: "live",
    agentStatus: terminal.status ?? undefined, statusMessage: terminal.statusMessage,
  }])), [state]);
  const seen = () => new Set(activeId && document.visibilityState === "visible" && document.hasFocus() ? [`local:${activeId}`] : []);
  const { visible, dismiss } = useTerminalAttention(facts, seen);
  // Cards go through the Terminal window's toast host, keyed per terminal.
  useTerminalAttentionToasts(visible, (alert) => onOpen(alert.ref.tabId), dismiss);
  return null;
}
