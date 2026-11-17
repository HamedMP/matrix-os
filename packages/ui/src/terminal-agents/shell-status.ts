import { terminalVisualStatus, type TerminalTabFacts } from "./attention.js";

export type TerminalShellVisualStatus = "running" | "waiting" | "finished" | "idle";

export const TERMINAL_STATUS_LABEL = { running: "Working", waiting: "Needs you", finished: "Finished", idle: "Idle" } as const;

export const TERMINAL_WAITING_DOT_STYLE = {
  background: "#E0A12E",
  boxShadow: "0 0 0 4px rgba(224,161,46,0.25)",
} as const;

export const TERMINAL_FINISHED_DOT_COLOR = "#3BA55D";

/** One listed tab's status: live agent status wins over the saved list's own. */
export function terminalShellVisualStatus(shell: {
  agentVisualStatus?: TerminalShellVisualStatus; visualStatus?: TerminalShellVisualStatus;
  status?: "active" | "exited" | "degraded"; unread?: boolean;
}): TerminalShellVisualStatus {
  if (shell.agentVisualStatus) return shell.agentVisualStatus;
  if (shell.visualStatus) return shell.visualStatus;
  if (shell.status === "degraded") return "waiting";
  return shell.unread ? "finished" : "idle";
}

/**
 * Overlay live per-tab agent status from `/ws/terminal/events` onto listed tabs
 * (keyed by `workspaceId:tabId`), in its own field. The overlay is recomputed
 * every time, so a copy written back into the saved list never keeps a stale
 * status. Returns the same array when nothing changed.
 */
export function mergeTerminalAgentStatus<T extends { name: string; agentVisualStatus?: TerminalShellVisualStatus }>(
  shells: T[],
  tabs: Readonly<Record<string, TerminalTabFacts>>,
): T[] {
  let changed = false;
  const merged = shells.map((shell) => {
    const facts = tabs[shell.name];
    const agentVisualStatus = facts?.state === "live" ? terminalVisualStatus(facts.agentStatus) : undefined;
    if (shell.agentVisualStatus === agentVisualStatus) return shell;
    changed = true;
    const { agentVisualStatus: _previous, ...rest } = shell;
    void _previous;
    return (agentVisualStatus ? { ...rest, agentVisualStatus } : rest) as T;
  });
  return changed ? merged : shells;
}
