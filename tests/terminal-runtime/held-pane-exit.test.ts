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

  subscribeCalls = 0;
  observerCloses = 0;
  readonly failingSessions = new Set<string>();

  async subscribeWorkspace(): Promise<ZellijObserver> {
    this.subscribeCalls += 1;
    const observer = { closed: false, close: async () => { observer.closed = true; this.observerCloses += 1; } };
    return observer;
  }

  async listHeldPaneExits(sessionName: string) {
    this.listCalls += 1;
    if (this.failingSessions.has(sessionName)) throw new Error("session unavailable");
    return this.exits.get(sessionName) ?? [];
  }
}

async function setup(options: { maxObservers?: number } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-held-pane-"));
  homes.push(homePath);
  const store = new TerminalWorkspaceStore({ homePath });
  const zellij = new HeldPaneZellij();
  const runtime = new TerminalRuntime({ store, zellij, ...options });
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

// Fault detected (review of #3297): one workspace whose zellij session stayed
// unavailable stopped every pass, so other workspaces' exits were never recorded.
describe("held-pane exits across workspaces", () => {
  it("records other workspaces' exits when one session cannot be read", async () => {
    const { store, zellij, runtime, ref, runtimeTab, session } = await setup();
    const other = await runtime.ensureWorkspace({ projectId: "docs" });
    const otherTab = await runtime.createTab(other.id, { name: "build", cwd: "", command: ["make"] });
    const otherRuntime = (await store.getRuntimeWorkspace(other.id))!;
    const otherRef = { workspaceId: other.id, tabId: otherTab.id };
    // Fail whichever session the sweep reads first.
    const [first] = await store.listWorkspaces();
    const firstSession = first!.id === ref.workspaceId ? session : otherRuntime.zellijSessionName;
    zellij.failingSessions.add(firstSession);
    zellij.exits.set(session, [{ tabId: runtimeTab.zellijTabId!, paneId: runtimeTab.zellijPaneId!, exitCode: 4 }]);
    const otherPane = otherRuntime.tabs[otherTab.id]!;
    zellij.exits.set(otherRuntime.zellijSessionName, [{ tabId: otherPane.zellijTabId!, paneId: otherPane.zellijPaneId!, exitCode: 5 }]);

    await expect(runtime.sweepHeldPaneExits()).resolves.toMatchObject({ exited: 1 });

    const recorded = firstSession === session ? otherRef : ref;
    await expect(store.getTab(recorded)).resolves.toMatchObject({ status: "exited" });
    await runtime.shutdown();
  });

  // Fault detected (review of #3297): recording an exit kept the workspace observer,
  // so finished projects held observer slots until new terminals failed with capacity.
  it("releases the observer of a workspace whose last command finished", async () => {
    const { zellij, runtime, runtimeTab, session } = await setup({ maxObservers: 1 });
    zellij.exits.set(session, [{ tabId: runtimeTab.zellijTabId!, paneId: runtimeTab.zellijPaneId!, exitCode: 0 }]);

    await runtime.sweepHeldPaneExits();

    const next = await runtime.ensureWorkspace({ projectId: "next" });
    await expect(runtime.createTab(next.id, { name: "shell", cwd: "" })).resolves.toMatchObject({ status: "running" });
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
