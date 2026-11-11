"use client";

import { useEffect, useMemo } from "react";
import { terminalVisualStatus, type TerminalTabFacts } from "@matrix-os/ui/terminal-agents";
import { useTerminalAgentEvents } from "@/stores/terminal-agent-events";
import type { ShellSessionSummary } from "./terminal-session-state";

/** Overlay live per-tab agent status from `/ws/terminal/events` onto listed shells. */
export function mergeShellAgentStatus(
  shells: ShellSessionSummary[],
  tabs: Readonly<Record<string, TerminalTabFacts>>,
): ShellSessionSummary[] {
  let changed = false;
  const merged = shells.map((shell) => {
    const facts = tabs[shell.name];
    const visualStatus = facts?.state === "live" ? terminalVisualStatus(facts.agentStatus) : undefined;
    if (!visualStatus) return shell;
    changed = true;
    return {
      ...shell,
      visualStatus,
      ...(facts?.statusMessage ? { subtitle: facts.statusMessage } : {}),
    };
  });
  return changed ? merged : shells;
}

export function useShellsWithAgentStatus(shells: ShellSessionSummary[]): ShellSessionSummary[] {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const retain = useTerminalAgentEvents((state) => state.retain);
  useEffect(() => retain(), [retain]);
  return useMemo(() => mergeShellAgentStatus(shells, tabs), [shells, tabs]);
}
