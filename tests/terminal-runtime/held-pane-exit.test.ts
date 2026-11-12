import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TerminalRuntime,
  type ZellijAttachment,
  type ZellijObserver,
  type ZellijRuntimeAdapter,
} from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { heldPaneExitsFromPanes } from "../../packages/terminal-runtime/src/terminal-command-state.js";
import { startHeldPaneExitSweep } from "../../packages/terminal-runtime/src/held-pane-exit-sweep.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** Zellij as the runtime sees it: tabs plus the held-pane exits `list-panes` reports. */
class HeldPaneZellij implements ZellijRuntimeAdapter {
  readonly sessions = new Map<string, Map<number, { name: string; paneId: string }>>();
  readonly exits = new Map<string, Array<{ tabId: number; paneId: string; exitCode: number }>>();
  listCalls = 0;
  private nextTabId = 1;

  async ensureSession(sessionName: string): Promise<void> {
    if (!this.sessions.has(sessionName)) this.sessions.set(sessionName, new Map());
  }

  async createTab(sessionName: string, input: { internalName: string }): Promise<{ tabId: number; paneId: string }> {
    const tabId = this.nextTabId++;
    const paneId = `terminal_${tabId}`;
    this.sessions.get(sessionName)!.set(tabId, { name: input.internalName, paneId });
    return { tabId, paneId };
  }

  async findTabByInternalName(sessionName: string, internalName: string) {
    const entry = [...(this.sessions.get(sessionName)?.entries() ?? [])].find(([, tab]) => tab.name === internalName);
    return entry ? { tabId: entry[0], paneId: entry[1].paneId } : undefined;
  }

  async openAttachment(): Promise<ZellijAttachment> {
    return { write: async () => undefined, resize: async () => undefined, close: async () => undefined };
  }

  async subscribeWorkspace(): Promise<ZellijObserver> {
    return { closed: false, close: async () => undefined };
  }

  async listHeldPaneExits(sessionName: string) {
    this.listCalls += 1;
    return this.exits.get(sessionName) ?? [];
  }
}

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-held-pane-"));
  homes.push(homePath);
  const store = new TerminalWorkspaceStore({ homePath });
  const zellij = new HeldPaneZellij();
  const runtime = new TerminalRuntime({ store, zellij });
  const workspace = await runtime.ensureWorkspace({ projectId: "app" });
  const tab = await runtime.createTab(workspace.id, { name: "tests", cwd: "", command: ["bun", "test"] });
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  const runtimeTab = (await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]!;
  const session = (await store.getRuntimeWorkspace(workspace.id))!.zellijSessionName;
  return { store, zellij, runtime, ref, runtimeTab, session };
}

// Fault detected (live test on the #3300 preview): a command tab's program exited, but
// zellij keeps its pane open and sends no pane_closed, so the tab stayed live forever:
// `wait` never returned the exit and no exit code was ever recorded.
describe("exits of programs whose pane zellij keeps open", () => {
  it("marks the tab exited with the program's exit code", async () => {
    const { store, zellij, runtime, ref, runtimeTab, session } = await setup();
    zellij.exits.set(session, [{ tabId: runtimeTab.zellijTabId!, paneId: runtimeTab.zellijPaneId!, exitCode: 3 }]);

    await expect(runtime.sweepHeldPaneExits()).resolves.toEqual({ sessions: 1, exited: 1 });

    await expect(store.getTab(ref)).resolves.toMatchObject({ status: "exited", exitCode: 3 });
    await runtime.shutdown();
  });

  it("leaves running programs and other tabs' panes alone", async () => {
    const { store, zellij, runtime, ref, runtimeTab, session } = await setup();
    zellij.exits.set(session, [{ tabId: runtimeTab.zellijTabId! + 40, paneId: "terminal_99", exitCode: 1 }]);

    await expect(runtime.sweepHeldPaneExits()).resolves.toEqual({ sessions: 1, exited: 0 });

    await expect(store.getTab(ref)).resolves.toMatchObject({ status: "running" });
    await runtime.shutdown();
  });

  it("skips workspaces without live tabs and does nothing on an already ended tab", async () => {
    const { store, zellij, runtime, ref, runtimeTab, session } = await setup();
    await store.markTabExited(ref, 0);
    zellij.exits.set(session, [{ tabId: runtimeTab.zellijTabId!, paneId: runtimeTab.zellijPaneId!, exitCode: 9 }]);

    await expect(runtime.sweepHeldPaneExits()).resolves.toEqual({ sessions: 0, exited: 0 });

    expect(zellij.listCalls).toBe(0);
    await expect(store.getTab(ref)).resolves.toMatchObject({ status: "exited", exitCode: 0 });
    await runtime.shutdown();
  });
});

describe("reading held-pane exits from list-panes", () => {
  it("returns only terminal panes zellij holds after their program exited", () => {
    expect(heldPaneExitsFromPanes([
      { id: 1, tab_id: 1, is_plugin: false, exited: true, is_held: true, exit_status: 3 },
      { id: 2, tab_id: 2, is_plugin: false, exited: false, is_held: false, exit_status: null },
      { id: 3, tab_id: 3, is_plugin: true, exited: true, is_held: true, exit_status: 0 },
      { id: 4, tab_id: 4, is_plugin: false, exited: true, is_held: true, exit_status: 999 },
    ])).toEqual([{ tabId: 1, paneId: "terminal_1", exitCode: 3 }]);
    expect(heldPaneExitsFromPanes({ not: "panes" })).toEqual([]);
  });
});

describe("held-pane exit sweep lifecycle", () => {
  it("never overlaps passes and waits for the running pass on close", async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let passes = 0;
    const sweep = startHeldPaneExitSweep({
      intervalMs: 5,
      sweep: async () => {
        passes += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await blocked;
        active -= 1;
        return { sessions: 0, exited: 0 };
      },
      logFailed: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closing = sweep.close();
    release();
    await closing;
    expect(maxActive).toBe(1);
    expect(passes).toBe(1);
  });
});
