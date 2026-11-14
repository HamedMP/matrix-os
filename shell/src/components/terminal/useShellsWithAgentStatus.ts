"use client";

import { useEffect, useMemo } from "react";
import { terminalVisualStatus, type TerminalTabFacts } from "@matrix-os/ui/terminal-agents";
import { useTerminalAgentEvents } from "@/stores/terminal-agent-events";
import type { ShellSessionSummary } from "./terminal-session-state";

/**
 * Overlay live per-tab agent status from `/ws/terminal/events` onto listed shells,
 * in its own field. The overlay is recomputed every time, so a copy written back
 * into the saved list (a pin, a rename) never keeps a stale status.
 */
export function mergeShellAgentStatus(
  shells: ShellSessionSummary[],
  tabs: Readonly<Record<string, TerminalTabFacts>>,
): ShellSessionSummary[] {
  let changed = false;
  const merged = shells.map((shell) => {
    const facts = tabs[shell.name];
    const agentVisualStatus = facts?.state === "live" ? terminalVisualStatus(facts.agentStatus) : undefined;
    if (shell.agentVisualStatus === agentVisualStatus) return shell;
    changed = true;
    const { agentVisualStatus: _previous, ...rest } = shell;
    void _previous;
    return agentVisualStatus ? { ...rest, agentVisualStatus } : rest;
  });
  return changed ? merged : shells;
}

export function useShellsWithAgentStatus(shells: ShellSessionSummary[]): ShellSessionSummary[] {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const retain = useTerminalAgentEvents((state) => state.retain);
  useEffect(() => retain(), [retain]);
  return useMemo(() => mergeShellAgentStatus(shells, tabs), [shells, tabs]);
}
