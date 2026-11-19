"use client";

import { useEffect, useMemo } from "react";
import { mergeTerminalAgentStatus, type TerminalTabFacts } from "@matrix-os/ui/terminal-agents";
import { useTerminalAgentEvents } from "@/stores/terminal-agent-events";
import type { ShellSessionSummary } from "./terminal-session-state";

/** Overlay live per-tab agent status from `/ws/terminal/events` onto listed shells. */
export function mergeShellAgentStatus(
  shells: ShellSessionSummary[],
  tabs: Readonly<Record<string, TerminalTabFacts>>,
): ShellSessionSummary[] {
  return mergeTerminalAgentStatus(shells, tabs);
}

export function useShellsWithAgentStatus(shells: ShellSessionSummary[]): ShellSessionSummary[] {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const retain = useTerminalAgentEvents((state) => state.retain);
  useEffect(() => retain(), [retain]);
  return useMemo(() => mergeShellAgentStatus(shells, tabs), [shells, tabs]);
}
