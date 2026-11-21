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
  /** Set when the pane runs the native-host attach helper rather than the program. */
  nativeHost?: unknown;
  /** False for a shell pane, whose exit closes it; absent in older state. */
  heldOnExit?: boolean;
}

/**
 * One pass over one workspace snapshot: for each workspace with live tabs, ask zellij
 * once which panes it holds after their program exited, and record those tabs' exits.
 * Bounded by `maxSessions`.
 */
export async function sweepHeldPaneExits(input: {
  /** One snapshot of every workspace for the pass; `record` re-checks a tab under the lock. */
  workspaces: Array<{ id: string; zellijSessionName: string; tabs: Record<string, SweepTab> }>;
  maxSessions: number;
  listHeldPaneExits(sessionName: string): Promise<HeldPaneExit[]>;
  /** Re-checks the tab under the workspace lock; false when it changed or already ended. */
  record(ref: TerminalRef, expected: { zellijTabName: string; paneId: string }, exitCode: number): Promise<boolean>;
  /** One workspace's failure is logged and the pass continues with the next workspace. */
  logFailed(error: unknown): void;
}): Promise<HeldPaneExitSweepResult> {
  const result: HeldPaneExitSweepResult = { sessions: 0, exited: 0 };
  for (const workspace of input.workspaces) {
    if (result.sessions >= input.maxSessions) break;
    const workspaceId = workspace.id;
    // A native tab's pane holds the attach helper, which can exit while the program
    // keeps running; its host owns that tab's lifetime, so the sweep never ends it.
    const live = Object.entries(workspace.tabs).filter(([, tab]) =>
      !tab.nativeHost && tab.status !== "exited" && tab.status !== "failed"
      && tab.zellijTabId !== null && tab.zellijPaneId !== null);
    // Each `list-panes` makes Zellij redraw every attached client, so a workspace
    // whose live tabs are all shells (their exit closes the pane) is not asked.
    if (!live.some(([, tab]) => tab.heldOnExit !== false)) continue;
    result.sessions += 1;
    try {
      const exits = await input.listHeldPaneExits(workspace.zellijSessionName);
      for (const exit of exits) {
        const match = live.find(([, tab]) => tab.zellijTabId === exit.tabId && tab.zellijPaneId === exit.paneId);
        if (!match) continue;
        const [tabId, tab] = match;
        if (await input.record({ workspaceId, tabId }, { zellijTabName: tab.zellijTabName, paneId: exit.paneId }, exit.exitCode)) {
          result.exited += 1;
        }
      }
    } catch (error) {
      input.logFailed(error);
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
