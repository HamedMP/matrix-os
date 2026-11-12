import type { TerminalRef } from "@matrix-os/contracts";
import type { HeldPaneExit } from "./terminal-command-state.js";

export interface HeldPaneExitSweepResult {
  sessions: number;
  exited: number;
}

interface SweepTab {
  status: string;
  zellijTabName: string;
  zellijTabId: number | null;
  zellijPaneId: string | null;
}

/**
 * One pass: for each workspace with live tabs, ask zellij once which panes it holds
 * after their program exited, and record those tabs' exits. Bounded by `maxSessions`.
 */
export async function sweepHeldPaneExits(input: {
  workspaceIds: string[];
  maxSessions: number;
  readWorkspace(workspaceId: string): Promise<{ zellijSessionName: string; tabs: Record<string, SweepTab> } | undefined>;
  listHeldPaneExits(sessionName: string): Promise<HeldPaneExit[]>;
  /** Re-checks the tab under the workspace lock; false when it changed or already ended. */
  record(ref: TerminalRef, expected: { zellijTabName: string; paneId: string }, exitCode: number): Promise<boolean>;
}): Promise<HeldPaneExitSweepResult> {
  const result: HeldPaneExitSweepResult = { sessions: 0, exited: 0 };
  for (const workspaceId of input.workspaceIds) {
    if (result.sessions >= input.maxSessions) break;
    const workspace = await input.readWorkspace(workspaceId);
    if (!workspace) continue;
    const live = Object.entries(workspace.tabs).filter(([, tab]) =>
      tab.status !== "exited" && tab.status !== "failed" && tab.zellijTabId !== null && tab.zellijPaneId !== null);
    if (live.length === 0) continue;
    result.sessions += 1;
    const exits = await input.listHeldPaneExits(workspace.zellijSessionName);
    for (const exit of exits) {
      const match = live.find(([, tab]) => tab.zellijTabId === exit.tabId && tab.zellijPaneId === exit.paneId);
      if (!match) continue;
      const [tabId, tab] = match;
      if (await input.record({ workspaceId, tabId }, { zellijTabName: tab.zellijTabName, paneId: exit.paneId }, exit.exitCode)) {
        result.exited += 1;
      }
    }
  }
  return result;
}

/** Runs the sweep on an interval; passes never overlap, and close waits for the running one. */
export function startHeldPaneExitSweep(options: {
  intervalMs: number;
  sweep: () => Promise<HeldPaneExitSweepResult>;
  logFailed: (error: unknown) => void;
}): { close: () => Promise<void> } {
  let closed = false;
  let active: Promise<void> | null = null;
  const run = () => {
    if (closed || active) return;
    const pass = Promise.resolve().then(options.sweep).then(() => undefined, options.logFailed);
    active = pass;
    void pass.finally(() => { if (active === pass) active = null; });
  };
  const timer = setInterval(run, options.intervalMs);
  timer.unref?.();
  run();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
