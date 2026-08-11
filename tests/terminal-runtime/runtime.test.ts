import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TerminalRuntime,
  type ZellijAttachment,
  type ZellijObserver,
  type ZellijObserverEvent,
  type ZellijRuntimeAdapter,
} from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

class FakeZellij implements ZellijRuntimeAdapter {
  readonly sessions = new Map<string, Map<number, { name: string; paneId: string }>>();
  readonly attachments = new Map<string, { handle: ZellijAttachment; emit: (data: Uint8Array) => void }>();
  readonly writes: string[] = [];
  readonly targetedWrites: string[] = [];
  readonly observers = new Map<string, { paneIds: string[]; emit: (event: ZellijObserverEvent) => void }>();
  readonly closedTabs: number[] = [];
  readonly deletedSessions: string[] = [];
  readonly renamedTabs: Array<{ tabId: number; name: string }> = [];
  readonly resizedSessions: Array<{ cols: number; rows: number }> = [];
  private nextTabId = 1;

  async ensureSession(sessionName: string): Promise<void> {
    if (!this.sessions.has(sessionName)) this.sessions.set(sessionName, new Map());
  }

  async createTab(sessionName: string, input: { internalName: string }): Promise<{ tabId: number; paneId: string }> {
    const tabs = this.sessions.get(sessionName);
    if (!tabs) throw new Error("missing session");
    const tabId = this.nextTabId++;
    const paneId = `terminal_${tabId}`;
    tabs.set(tabId, { name: input.internalName, paneId });
    return { tabId, paneId };
  }

  async findTabByInternalName(sessionName: string, internalName: string): Promise<{ tabId: number; paneId: string } | undefined> {
    const entry = [...(this.sessions.get(sessionName)?.entries() ?? [])]
      .find(([, tab]) => tab.name === internalName);
    return entry ? { tabId: entry[0], paneId: entry[1].paneId } : undefined;
  }

  async openAttachment(
    sessionName: string,
    input: { paneId: string; onData: (data: Uint8Array) => void },
  ): Promise<ZellijAttachment> {
    const key = `${sessionName}:${input.paneId}`;
    const handle: ZellijAttachment = {
      write: async (data) => { this.writes.push(new TextDecoder().decode(data)); },
      resize: async () => undefined,
      close: async () => { this.attachments.delete(key); },
    };
    this.attachments.set(key, { handle, emit: input.onData });
    return handle;
  }

  async subscribeWorkspace(
    sessionName: string,
    input: { paneIds: string[]; onEvent: (event: ZellijObserverEvent) => void },
  ): Promise<ZellijObserver> {
    this.observers.set(sessionName, { paneIds: input.paneIds, emit: input.onEvent });
    return { close: async () => { this.observers.delete(sessionName); } };
  }

  async closeTab(_sessionName: string, tabId: number): Promise<void> { this.closedTabs.push(tabId); }
  async deleteSession(sessionName: string): Promise<void> { this.deletedSessions.push(sessionName); }
  async renameTab(_sessionName: string, tabId: number, name: string): Promise<void> {
    this.renamedTabs.push({ tabId, name });
  }
  async resizeSession(_sessionName: string, size: { cols: number; rows: number }): Promise<void> {
    this.resizedSessions.push(size);
  }
  async writeToPane(_sessionName: string, _paneId: string, data: Uint8Array): Promise<void> {
    this.targetedWrites.push(new TextDecoder().decode(data));
  }
}

describe("project-scoped terminal runtime", () => {
  it("runs twenty-three tabs in exactly one Zellij server for their project", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({
      store: new TerminalWorkspaceStore({ homePath }),
      zellij,
    });

    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    for (let index = 0; index < 23; index += 1) {
      await runtime.createTab(workspace.id, {
        name: `tab ${index + 1}`,
        cwd: "projects/matrix-os",
      });
    }

    expect(zellij.sessions.size).toBe(1);
    expect([...zellij.sessions.values()][0]?.size).toBe(23);
    expect((await runtime.listWorkspaces())[0]?.tabs).toHaveLength(23);
  });

  it("shares one attachment per viewed tab while devices select and type independently", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const first = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    const second = await runtime.createTab(workspace.id, { name: "two", cwd: "projects/matrix-os" });
    const firstOutput: string[] = [];
    const secondOutput: string[] = [];

    const desktop = await runtime.attach({ workspaceId: workspace.id, tabId: first.id }, {
      viewerId: "desktop",
      send: (data) => { firstOutput.push(new TextDecoder().decode(data)); },
    });
    const mobile = await runtime.attach({ workspaceId: workspace.id, tabId: first.id }, {
      viewerId: "mobile",
      send: (data) => { secondOutput.push(new TextDecoder().decode(data)); },
    });
    expect(zellij.attachments.size).toBe(1);

    const attachment = [...zellij.attachments.values()][0];
    attachment?.emit(new TextEncoder().encode("shared output"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstOutput).toEqual(["shared output"]);
    expect(secondOutput).toEqual(["shared output"]);

    await Promise.all([desktop.write("a"), mobile.write("b")]);
    expect(zellij.writes).toEqual(["a", "b"]);

    const mobileSecondTab = await runtime.attach({ workspaceId: workspace.id, tabId: second.id }, {
      viewerId: "mobile-second-tab",
      send: () => undefined,
    });
    expect(zellij.attachments.size).toBe(2);
    await mobile.detach();
    expect(zellij.attachments.size).toBe(2);
    await desktop.detach();
    expect(zellij.attachments.size).toBe(1);
    await mobileSecondTab.detach();
    expect(zellij.attachments.size).toBe(0);
    expect((await runtime.listWorkspaces())[0]?.tabs.map((tab) => tab.status)).toEqual(["running", "running"]);
  });

  it("serializes agent input to a tab without creating a viewer attachment", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "agent", cwd: "projects/matrix-os" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };

    await Promise.all([runtime.writeInput(ref, "first"), runtime.writeInput(ref, "second")]);

    expect(zellij.targetedWrites).toEqual(["first", "second"]);
    expect(zellij.attachments.size).toBe(0);
    await runtime.shutdown();
  });

  it("checkpoints every background tab through one structured workspace observer", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "build", cwd: "projects/matrix-os" });
    const runtimeWorkspace = await store.getRuntimeWorkspace(workspace.id);
    const runtimeTab = runtimeWorkspace?.tabs[tab.id];

    expect(zellij.observers.size).toBe(1);
    zellij.observers.get(runtimeWorkspace!.zellijSessionName)?.emit({
      type: "pane-update",
      paneId: runtimeTab!.zellijPaneId!,
      ansi: "\u001b[32mbuild complete\u001b[0m",
      viewport: ["build complete", "$ "],
      scrollback: ["running build"],
    });
    await runtime.flushCheckpoints();

    expect(await runtime.getSnapshot({ workspaceId: workspace.id, tabId: tab.id })).toMatchObject({
      ansi: "\u001b[32mbuild complete\u001b[0m",
      viewport: ["build complete", "$ "],
      scrollback: ["running build"],
    });
    expect(zellij.attachments.size).toBe(0);

    await runtime.shutdown();
    const restarted = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: new FakeZellij() });
    expect((await restarted.getSnapshot({ workspaceId: workspace.id, tabId: tab.id }))?.scrollback).toEqual(["running build"]);
    await restarted.shutdown();
  });

  it("reconciles stable Matrix tab IDs after the Zellij server restarts", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const firstZellij = new FakeZellij();
    const firstRuntime = new TerminalRuntime({ store, zellij: firstZellij });
    const workspace = await firstRuntime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await firstRuntime.createTab(workspace.id, { name: "agent", cwd: "projects/matrix-os" });
    await firstRuntime.shutdown();

    const restartedZellij = new FakeZellij();
    const restartedRuntime = new TerminalRuntime({
      store: new TerminalWorkspaceStore({ homePath }),
      zellij: restartedZellij,
    });
    await restartedRuntime.restoreAll();

    const restored = (await restartedRuntime.listWorkspaces())[0]!;
    expect(restored.tabs[0]?.id).toBe(tab.id);
    expect(restartedZellij.sessions.size).toBe(1);
    expect([...restartedZellij.sessions.values()][0]?.size).toBe(1);
    await restartedRuntime.shutdown();
  });

  it("separates detach, tab termination, canonical hard sizing, and confirmed workspace deletion", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const first = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    const second = await runtime.createTab(workspace.id, { name: "two", cwd: "projects/matrix-os" });

    const renamed = await runtime.renameTab({ workspaceId: workspace.id, tabId: first.id }, {
      name: "build",
      baseRevision: first.revision,
    });
    expect(renamed.name).toBe("build");
    await runtime.resize({ workspaceId: workspace.id, tabId: first.id }, { mode: "soft", size: { cols: 40, rows: 10 } });
    expect(zellij.resizedSessions).toEqual([]);
    await runtime.resize({ workspaceId: workspace.id, tabId: first.id }, { mode: "hard", size: { cols: 160, rows: 48 } });
    expect(zellij.resizedSessions).toEqual([{ cols: 160, rows: 48 }]);

    await runtime.terminateTab({ workspaceId: workspace.id, tabId: first.id });
    expect(zellij.closedTabs).toHaveLength(1);
    expect((await runtime.listWorkspaces())[0]?.tabs.find((tab) => tab.id === second.id)?.status).toBe("running");
    expect((await runtime.deletionImpact(workspace.id)).runningTabs).toBe(1);
    await expect(runtime.deleteWorkspace(workspace.id, { confirmTerminate: false })).rejects.toThrow(/confirmation/i);
    await runtime.deleteWorkspace(workspace.id, { confirmTerminate: true });
    expect(zellij.deletedSessions).toHaveLength(1);
    await runtime.shutdown();
  });
});
