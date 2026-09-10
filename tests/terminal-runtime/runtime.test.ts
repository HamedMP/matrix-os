import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalPaneAction } from "@matrix-os/contracts";
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
  readonly observerHandles: Array<{ closed: boolean }> = [];
  readonly closedTabs: number[] = [];
  readonly deletedSessions: string[] = [];
  readonly renamedTabs: Array<{ tabId: number; name: string }> = [];
  readonly resizedSessions: Array<{ cols: number; rows: number }> = [];
  readonly paneActions: Array<{ sessionName: string; tabId: number; action: TerminalPaneAction }> = [];
  failNextSubscription = false;
  subscriptionFailuresRemaining = 0;
  failNextObserverClose = false;
  failAllObserverCloses = false;
  failNextCloseTab = false;
  nextSubscriptionPause?: { started: () => void; wait: Promise<void> };
  nextObserverClosePause?: { started: () => void; wait: Promise<void> };
  nextAttachmentWritePause?: { started: () => void; wait: Promise<void> };
  nextSessionDeletionPause?: { started: () => void; wait: Promise<void> };
  nextSessionDeletedPause?: { started: () => void; wait: Promise<void> };
  nextAttachmentOpenPause?: { started: () => void; wait: Promise<void> };
  nextTabCreated?: () => void;
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
    this.nextTabCreated?.();
    this.nextTabCreated = undefined;
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
    const pause = this.nextAttachmentOpenPause;
    if (pause) {
      this.nextAttachmentOpenPause = undefined;
      pause.started();
      await pause.wait;
    }
    const handle: ZellijAttachment = {
      write: async (data) => {
        const writePause = this.nextAttachmentWritePause;
        if (writePause) {
          this.nextAttachmentWritePause = undefined;
          writePause.started();
          await writePause.wait;
        }
        this.writes.push(new TextDecoder().decode(data));
      },
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
    if (this.failNextSubscription || this.subscriptionFailuresRemaining > 0) {
      this.failNextSubscription = false;
      this.subscriptionFailuresRemaining = Math.max(0, this.subscriptionFailuresRemaining - 1);
      throw new Error("observer subscription failed");
    }
    const pause = this.nextSubscriptionPause;
    if (pause) {
      this.nextSubscriptionPause = undefined;
      pause.started();
      await pause.wait;
    }
    const observer = { paneIds: input.paneIds, emit: input.onEvent };
    const handleState = { closed: false };
    this.observerHandles.push(handleState);
    this.observers.set(sessionName, observer);
    return {
      close: async () => {
        const closePause = this.nextObserverClosePause;
        if (closePause) {
          this.nextObserverClosePause = undefined;
          closePause.started();
          await closePause.wait;
        }
        if (this.failAllObserverCloses || this.failNextObserverClose) {
          this.failNextObserverClose = false;
          throw new Error("observer close failed");
        }
        handleState.closed = true;
        if (this.observers.get(sessionName) === observer) this.observers.delete(sessionName);
      },
    };
  }

  get activeObserverCount(): number {
    return this.observerHandles.filter((observer) => !observer.closed).length;
  }

  async closeTab(sessionName: string, tabId: number): Promise<void> {
    if (this.failNextCloseTab) {
      this.failNextCloseTab = false;
      throw new Error("close tab failed");
    }
    this.closedTabs.push(tabId);
    this.sessions.get(sessionName)?.delete(tabId);
  }
  async deleteSession(sessionName: string): Promise<void> {
    const pause = this.nextSessionDeletionPause;
    if (pause) {
      this.nextSessionDeletionPause = undefined;
      pause.started();
      await pause.wait;
    }
    this.deletedSessions.push(sessionName);
    this.sessions.delete(sessionName);
    const deletedPause = this.nextSessionDeletedPause;
    if (deletedPause) {
      this.nextSessionDeletedPause = undefined;
      deletedPause.started();
      await deletedPause.wait;
    }
  }
  async renameTab(_sessionName: string, tabId: number, name: string): Promise<void> {
    this.renamedTabs.push({ tabId, name });
  }
  async resizeSession(_sessionName: string, size: { cols: number; rows: number }): Promise<void> {
    this.resizedSessions.push(size);
  }
  async writeToPane(_sessionName: string, _paneId: string, data: Uint8Array): Promise<void> {
    this.targetedWrites.push(new TextDecoder().decode(data));
  }
  async paneAction(sessionName: string, tabId: number, action: TerminalPaneAction): Promise<void> {
    this.paneActions.push({ sessionName, tabId, action });
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

  it("rejects agent input after a tab has exited", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "agent", cwd: "projects/matrix-os" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };

    await runtime.terminateTab(ref);

    await expect(runtime.writeInput(ref, "late")).rejects.toThrow(/unavailable/i);
    expect(zellij.targetedWrites).toEqual([]);
    await runtime.shutdown();
  });

  it("rejects agent input while a pane-close checkpoint is pending", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "agent", cwd: "projects/matrix-os" });
    const runtimeWorkspace = await store.getRuntimeWorkspace(workspace.id);
    const runtimeTab = runtimeWorkspace?.tabs[tab.id];
    let signalExitStarted = () => undefined;
    let releaseExit = () => undefined;
    const exitStarted = new Promise<void>((resolve) => { signalExitStarted = resolve; });
    const exitRelease = new Promise<void>((resolve) => { releaseExit = resolve; });
    const markTabExited = store.markTabExited.bind(store);
    store.markTabExited = async (ref, exitCode = null) => {
      signalExitStarted();
      await exitRelease;
      return markTabExited(ref, exitCode);
    };

    zellij.observers.get(runtimeWorkspace!.zellijSessionName)?.emit({
      type: "pane-closed",
      paneId: runtimeTab!.zellijPaneId!,
    });
    await exitStarted;
    const lateWrite = runtime.writeInput({ workspaceId: workspace.id, tabId: tab.id }, "late").then(
      () => "accepted" as const,
      (error: unknown) => error instanceof Error ? error.message : "unknown",
    );

    releaseExit();
    await runtime.flushCheckpoints();
    await expect(lateWrite).resolves.toMatch(/clos|unavailable/i);
    expect(zellij.targetedWrites).toEqual([]);
    await runtime.shutdown();
  });

  it("drains admitted attachment input before a pane-close event closes the tab", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "agent", cwd: "projects/matrix-os" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const viewer = await runtime.attach(ref, { viewerId: "desktop", send: () => undefined });
    const runtimeWorkspace = await store.getRuntimeWorkspace(workspace.id);
    const runtimeTab = runtimeWorkspace?.tabs[tab.id];
    let signalWriteStarted = () => undefined;
    let releaseWrite = () => undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    zellij.nextAttachmentWritePause = { started: signalWriteStarted, wait: writeRelease };

    const firstWrite = viewer.write("first admitted");
    await writeStarted;
    const queuedWrite = viewer.write("second admitted");
    zellij.sessions.get(runtimeWorkspace!.zellijSessionName)?.delete(runtimeTab!.zellijTabId!);
    zellij.observers.get(runtimeWorkspace!.zellijSessionName)?.emit({
      type: "pane-closed",
      paneId: runtimeTab!.zellijPaneId!,
    });
    const checkpoint = runtime.flushCheckpoints();
    const finishedBeforeWrites = await Promise.race([
      checkpoint.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);

    expect(finishedBeforeWrites).toBe(false);
    releaseWrite();
    await Promise.all([firstWrite, queuedWrite, checkpoint]);
    expect(zellij.writes).toEqual(["first admitted", "second admitted"]);
    expect(zellij.attachments.size).toBe(0);
    await expect(store.getTab(ref)).resolves.toMatchObject({ status: "exited" });
    await runtime.shutdown();
  });

  it("recovers a transient pane-close persistence failure without leaking the input gate", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "agent", cwd: "projects/matrix-os" });
    const runtimeWorkspace = await store.getRuntimeWorkspace(workspace.id);
    const runtimeTab = runtimeWorkspace?.tabs[tab.id];
    const markTabExited = store.markTabExited.bind(store);
    let attempts = 0;
    store.markTabExited = async (ref, exitCode = null) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient persistence failure");
      return markTabExited(ref, exitCode);
    };

    zellij.observers.get(runtimeWorkspace!.zellijSessionName)?.emit({
      type: "pane-closed",
      paneId: runtimeTab!.zellijPaneId!,
    });
    await runtime.flushCheckpoints();

    expect(attempts).toBe(2);
    await expect(runtime.writeInput({ workspaceId: workspace.id, tabId: tab.id }, "late"))
      .rejects.toThrow(/unavailable/i);
    expect(zellij.targetedWrites).toEqual([]);
    await runtime.shutdown();
  });

  it("targets pane actions through the tab's stable runtime reference", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "agent", cwd: "projects/matrix-os" });

    await runtime.paneAction(
      { workspaceId: workspace.id, tabId: tab.id },
      { type: "fullscreen" },
    );

    expect(zellij.paneActions).toEqual([{
      sessionName: [...zellij.sessions.keys()][0],
      tabId: 1,
      action: { type: "fullscreen" },
    }]);

    await runtime.paneAction(
      { workspaceId: workspace.id, tabId: tab.id },
      { type: "close" },
    );

    expect(zellij.closedTabs).toEqual([1]);
    expect((await runtime.listWorkspaces())[0]?.tabs[0]?.status).toBe("exited");
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

  it("rejects a new active workspace at observer capacity without evicting an active observer", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({
      store: new TerminalWorkspaceStore({ homePath }),
      zellij,
      maxObservers: 1,
    });
    const first = await runtime.ensureWorkspace({ projectId: "first-project" });
    await runtime.createTab(first.id, { name: "first", cwd: "projects/first" });
    const firstRuntimeWorkspace = await new TerminalWorkspaceStore({ homePath }).getRuntimeWorkspace(first.id);
    const second = await runtime.ensureWorkspace({ projectId: "second-project" });
    const secondRuntimeWorkspace = await new TerminalWorkspaceStore({ homePath }).getRuntimeWorkspace(second.id);

    await expect(runtime.createTab(second.id, {
      name: "second",
      cwd: "projects/second",
    })).rejects.toThrow("Terminal observer capacity reached");

    expect(zellij.observers.has(firstRuntimeWorkspace!.zellijSessionName)).toBe(true);
    expect(zellij.observers.has(secondRuntimeWorkspace!.zellijSessionName)).toBe(false);
    expect(zellij.observers.size).toBe(1);
    expect((await runtime.listWorkspaces()).find((workspace) => workspace.id === second.id)?.tabs).toEqual([]);
    await runtime.shutdown();
  });

  it("keeps the existing workspace observer when its replacement subscription fails", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij, maxObservers: 1, sweepIntervalMs: 60_000 });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const first = await runtime.createTab(workspace.id, { name: "first", cwd: "projects/matrix-os" });
    const second = await runtime.createTab(workspace.id, { name: "second", cwd: "projects/matrix-os" });
    const runtimeWorkspace = await store.getRuntimeWorkspace(workspace.id);
    const secondRuntimeTab = runtimeWorkspace?.tabs[second.id];

    zellij.subscriptionFailuresRemaining = 2;
    await expect(runtime.terminateTab({ workspaceId: workspace.id, tabId: first.id }))
      .rejects.toThrow("Terminal observer restoration failed");

    await expect.poll(() => zellij.activeObserverCount).toBe(1);
    const observer = zellij.observers.get(runtimeWorkspace!.zellijSessionName);
    expect(observer).toBeDefined();
    observer?.emit({
      type: "pane-update",
      paneId: secondRuntimeTab!.zellijPaneId!,
      ansi: "still observed",
      viewport: ["still observed"],
      scrollback: [],
    });
    await runtime.flushCheckpoints();
    expect(await runtime.getSnapshot({ workspaceId: workspace.id, tabId: second.id })).toMatchObject({
      ansi: "still observed",
      viewport: ["still observed"],
    });
    await runtime.shutdown();
  });

  it("cleans up the replacement when the old observer cannot close", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const first = await runtime.createTab(workspace.id, { name: "first", cwd: "projects/matrix-os" });
    await runtime.createTab(workspace.id, { name: "second", cwd: "projects/matrix-os" });

    zellij.failNextObserverClose = true;
    await expect(runtime.terminateTab({ workspaceId: workspace.id, tabId: first.id }))
      .rejects.toThrow("observer close failed");
    expect(zellij.activeObserverCount).toBe(1);

    await runtime.shutdown();
    expect(zellij.activeObserverCount).toBe(0);
  });

  it("does not accumulate observers when both sides of a replacement fail to close", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({
      store: new TerminalWorkspaceStore({ homePath }),
      zellij,
      maxObservers: 2,
    });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const first = await runtime.createTab(workspace.id, { name: "first", cwd: "projects/matrix-os" });
    const second = await runtime.createTab(workspace.id, { name: "second", cwd: "projects/matrix-os" });
    await runtime.createTab(workspace.id, { name: "third", cwd: "projects/matrix-os" });

    zellij.failAllObserverCloses = true;
    await expect(runtime.terminateTab({ workspaceId: workspace.id, tabId: first.id }))
      .rejects.toThrow("Terminal observer replacement cleanup failed");
    expect(zellij.activeObserverCount).toBe(2);
    await expect(runtime.terminateTab({ workspaceId: workspace.id, tabId: second.id }))
      .rejects.toThrow("observer close failed");
    expect(zellij.activeObserverCount).toBe(2);

    zellij.failAllObserverCloses = false;
    await runtime.shutdown();
    expect(zellij.activeObserverCount).toBe(0);
  });

  it("retains the last observer when closing a zero-pane workspace observer fails", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const store = new TerminalWorkspaceStore({ homePath });
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    await store.removeTab({ workspaceId: workspace.id, tabId: tab.id });

    zellij.failNextObserverClose = true;
    await expect(runtime.ensureWorkspace({ projectId: "matrix-os" }))
      .rejects.toThrow("observer close failed");
    expect(zellij.activeObserverCount).toBe(1);

    await runtime.shutdown();
    expect(zellij.activeObserverCount).toBe(0);
  });

  it("retains observer ownership when workspace deletion cannot close it", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });

    zellij.failNextObserverClose = true;
    await expect(runtime.deleteWorkspace(workspace.id, { confirmTerminate: true }))
      .rejects.toThrow("observer close failed");
    expect(zellij.activeObserverCount).toBe(1);
    expect(await runtime.listWorkspaces()).toHaveLength(1);
    expect(zellij.deletedSessions).toEqual([]);

    await runtime.shutdown();
    expect(zellij.activeObserverCount).toBe(0);
  });

  it("rolls back the canonical and Zellij tab when initial observation fails", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    zellij.failNextSubscription = true;

    await expect(runtime.createTab(workspace.id, { name: "failed", cwd: "projects/matrix-os" }))
      .rejects.toThrow("observer subscription failed");

    expect((await runtime.listWorkspaces())[0]?.tabs).toEqual([]);
    expect([...zellij.sessions.values()][0]?.size).toBe(0);
    expect(zellij.closedTabs).toEqual([1]);
    await runtime.shutdown();
  });

  it("removes the canonical tab even when Zellij rollback fails", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    zellij.failNextSubscription = true;
    zellij.failNextCloseTab = true;

    await expect(runtime.createTab(workspace.id, { name: "failed", cwd: "projects/matrix-os" }))
      .rejects.toThrow("observer subscription failed");
    expect((await runtime.listWorkspaces())[0]?.tabs).toEqual([]);
    await runtime.shutdown();
  });

  it("removes a replacement observer when workspace deletion overlaps its subscription", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const first = await runtime.createTab(workspace.id, { name: "first", cwd: "projects/matrix-os" });
    await runtime.createTab(workspace.id, { name: "second", cwd: "projects/matrix-os" });
    const runtimeWorkspace = await store.getRuntimeWorkspace(workspace.id);
    let signalSubscriptionStarted = () => undefined;
    let releaseSubscription = () => undefined;
    const subscriptionStarted = new Promise<void>((resolve) => { signalSubscriptionStarted = resolve; });
    const subscriptionRelease = new Promise<void>((resolve) => { releaseSubscription = resolve; });
    zellij.nextSubscriptionPause = { started: signalSubscriptionStarted, wait: subscriptionRelease };

    const restart = runtime.terminateTab({ workspaceId: workspace.id, tabId: first.id });
    await subscriptionStarted;
    const deletion = runtime.deleteWorkspace(workspace.id, { confirmTerminate: true });
    const deletionFinishedBeforeRelease = await Promise.race([
      deletion.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    releaseSubscription();
    await Promise.all([restart, deletion]);

    expect(deletionFinishedBeforeRelease).toBe(false);
    expect(zellij.observers.has(runtimeWorkspace!.zellijSessionName)).toBe(false);
    expect(await runtime.listWorkspaces()).toEqual([]);
    expect(zellij.deletedSessions).toContain(runtimeWorkspace!.zellijSessionName);
    await runtime.shutdown();
  });

  it("does not create a tab while deletion owns the workspace lifecycle", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    let signalDeletionStarted = () => undefined;
    let releaseDeletion = () => undefined;
    let signalTabCreated = () => undefined;
    const deletionStarted = new Promise<void>((resolve) => { signalDeletionStarted = resolve; });
    const deletionRelease = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    const tabCreated = new Promise<void>((resolve) => { signalTabCreated = resolve; });
    zellij.nextSessionDeletionPause = { started: signalDeletionStarted, wait: deletionRelease };
    zellij.nextTabCreated = signalTabCreated;

    const deletion = runtime.deleteWorkspace(workspace.id, { confirmTerminate: false });
    await deletionStarted;
    const creation = runtime.createTab(workspace.id, { name: "racing", cwd: "projects/matrix-os" });
    const tabCreatedBeforeDeletionFinished = await Promise.race([
      tabCreated.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    releaseDeletion();
    await deletion;
    await expect(creation).rejects.toThrow("Terminal workspace not found");

    expect(tabCreatedBeforeDeletionFinished).toBe(false);
    expect(zellij.sessions.size).toBe(0);
    expect(await runtime.listWorkspaces()).toEqual([]);
    await runtime.shutdown();
  });

  it("does not reconcile a session while workspace deletion is removing canonical state", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    let signalDeleted = () => undefined;
    let releaseDeletion = () => undefined;
    const deleted = new Promise<void>((resolve) => { signalDeleted = resolve; });
    const deletionRelease = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    zellij.nextSessionDeletedPause = { started: signalDeleted, wait: deletionRelease };

    const deletion = runtime.deleteWorkspace(workspace.id, { confirmTerminate: false });
    await deleted;
    const reconciliation = runtime.ensureWorkspace({ projectId: "matrix-os" });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    releaseDeletion();
    await deletion;
    await expect(reconciliation).rejects.toThrow("Terminal workspace not found");
    expect(zellij.sessions.size).toBe(0);
    await runtime.shutdown();
  });

  it("drains a pending attachment before deleting its workspace", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    let signalOpening = () => undefined;
    let releaseAttachment = () => undefined;
    const opening = new Promise<void>((resolve) => { signalOpening = resolve; });
    const attachmentRelease = new Promise<void>((resolve) => { releaseAttachment = resolve; });
    zellij.nextAttachmentOpenPause = { started: signalOpening, wait: attachmentRelease };

    const attachment = runtime.attach({ workspaceId: workspace.id, tabId: tab.id }, {
      viewerId: "desktop",
      send: () => undefined,
    });
    await opening;
    const deletion = runtime.deleteWorkspace(workspace.id, { confirmTerminate: true });
    const deletionFinishedBeforeRelease = await Promise.race([
      deletion.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    releaseAttachment();
    await Promise.all([attachment, deletion]);
    expect(deletionFinishedBeforeRelease).toBe(false);
    expect(zellij.attachments.size).toBe(0);
    await runtime.shutdown();
  });

  it("drains a pending attachment before shutdown completes", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    let signalOpening = () => undefined;
    let releaseAttachment = () => undefined;
    const opening = new Promise<void>((resolve) => { signalOpening = resolve; });
    const attachmentRelease = new Promise<void>((resolve) => { releaseAttachment = resolve; });
    zellij.nextAttachmentOpenPause = { started: signalOpening, wait: attachmentRelease };
    const attachment = runtime.attach({ workspaceId: workspace.id, tabId: tab.id }, {
      viewerId: "desktop", send: () => undefined,
    });
    await opening;
    const shutdown = runtime.shutdown();
    const finishedEarly = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    releaseAttachment();
    await Promise.all([attachment, shutdown]);
    expect(finishedEarly).toBe(false);
    expect(zellij.attachments.size).toBe(0);
  });

  it("drains queued terminal writes before shutdown closes attachments", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    const viewer = await runtime.attach({ workspaceId: workspace.id, tabId: tab.id }, {
      viewerId: "desktop", send: () => undefined,
    });
    let signalWriteStarted = () => undefined;
    let releaseWrite = () => undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    zellij.nextAttachmentWritePause = { started: signalWriteStarted, wait: writeRelease };

    const write = viewer.write("pending");
    await writeStarted;
    const shutdown = runtime.shutdown();
    const finishedBeforeWrite = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    expect(finishedBeforeWrite).toBe(false);

    releaseWrite();
    await Promise.all([write, shutdown]);
    expect(zellij.writes).toEqual(["pending"]);
    expect(zellij.attachments.size).toBe(0);
  });

  it("drains admitted input without stranding a viewer that reconnects during cleanup", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const viewer = await runtime.attach(ref, { viewerId: "desktop", send: () => undefined });
    let signalWriteStarted = () => undefined;
    let releaseWrite = () => undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    zellij.nextAttachmentWritePause = { started: signalWriteStarted, wait: writeRelease };

    const write = viewer.write("admitted");
    await writeStarted;
    const reconnecting = runtime.attach(ref, { viewerId: "mobile", send: () => undefined });
    await Promise.resolve();
    const detach = viewer.detach();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    try {
      expect(zellij.attachments.size).toBe(1);
    } finally {
      releaseWrite();
      await write;
    }
    const reconnected = await reconnecting;
    await detach;
    expect(zellij.attachments.size).toBe(1);
    await reconnected.write("after reconnect");
    expect(zellij.writes).toEqual(["admitted", "after reconnect"]);
    await reconnected.detach();
    await runtime.shutdown();
  });

  it("drains admitted input and rejects new writes while terminating a tab", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const viewer = await runtime.attach(ref, { viewerId: "desktop", send: () => undefined });
    let signalWriteStarted = () => undefined;
    let releaseWrite = () => undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    zellij.nextAttachmentWritePause = { started: signalWriteStarted, wait: writeRelease };

    const write = viewer.write("admitted");
    await writeStarted;
    const queuedWrite = viewer.write("queued-before-termination");
    const termination = runtime.terminateTab(ref);
    const lateWrite = runtime.writeInput(ref, "late").then(
      () => "accepted" as const,
      (error: unknown) => error instanceof Error ? error.message : "unknown",
    );
    const finishedBeforeWrite = await Promise.race([
      termination.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);

    expect(finishedBeforeWrite).toBe(false);
    await expect(lateWrite).resolves.toMatch(/terminat/i);
    releaseWrite();
    await Promise.all([write, queuedWrite, termination]);
    expect(zellij.writes).toEqual(["admitted", "queued-before-termination"]);
    expect(zellij.targetedWrites).toEqual([]);
    expect(zellij.closedTabs).toHaveLength(1);
    await runtime.shutdown();
  });

  it("drains admitted input and rejects new writes while deleting a workspace", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const viewer = await runtime.attach(ref, { viewerId: "desktop", send: () => undefined });
    let signalWriteStarted = () => undefined;
    let releaseWrite = () => undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    zellij.nextAttachmentWritePause = { started: signalWriteStarted, wait: writeRelease };
    let signalDeletionStarted = () => undefined;
    let releaseDeletion = () => undefined;
    const deletionStarted = new Promise<void>((resolve) => { signalDeletionStarted = resolve; });
    const deletionRelease = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    zellij.nextSessionDeletionPause = { started: signalDeletionStarted, wait: deletionRelease };

    const write = viewer.write("admitted");
    await writeStarted;
    const deletion = runtime.deleteWorkspace(workspace.id, { confirmTerminate: true });
    const deletionReachedSessionBeforeWrite = await Promise.race([
      deletionStarted.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    releaseWrite();
    await write;
    await deletionStarted;
    const lateWrite = runtime.writeInput(ref, "late").then(
      () => "accepted" as const,
      (error: unknown) => error instanceof Error ? error.message : "unknown",
    );
    const lateWriteResult = await lateWrite;
    releaseDeletion();
    await deletion;

    expect(deletionReachedSessionBeforeWrite).toBe(false);
    expect(lateWriteResult).toMatch(/delet/i);
    expect(zellij.writes).toEqual(["admitted"]);
    expect(zellij.targetedWrites).toEqual([]);
    await runtime.shutdown();
  });

  it("stops observer events before the final shutdown checkpoint drain", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-runtime-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new FakeZellij();
    const runtime = new TerminalRuntime({ store, zellij });
    const workspace = await runtime.ensureWorkspace({ projectId: "matrix-os" });
    const tab = await runtime.createTab(workspace.id, { name: "one", cwd: "projects/matrix-os" });
    const runtimeWorkspace = await store.getRuntimeWorkspace(workspace.id);
    const runtimeTab = runtimeWorkspace!.tabs[tab.id]!;
    const observer = zellij.observers.get(runtimeWorkspace!.zellijSessionName)!;
    let signalObserverClosing = () => undefined;
    let releaseObserverClose = () => undefined;
    const observerClosing = new Promise<void>((resolve) => { signalObserverClosing = resolve; });
    const observerCloseRelease = new Promise<void>((resolve) => { releaseObserverClose = resolve; });
    zellij.nextObserverClosePause = { started: signalObserverClosing, wait: observerCloseRelease };
    let signalCheckpointStarted = () => undefined;
    let releaseCheckpoint = () => undefined;
    const checkpointStarted = new Promise<void>((resolve) => { signalCheckpointStarted = resolve; });
    const checkpointRelease = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const checkpointTab = store.checkpointTab.bind(store);
    store.checkpointTab = async (...args) => {
      signalCheckpointStarted();
      await checkpointRelease;
      return checkpointTab(...args);
    };

    const shutdown = runtime.shutdown();
    await observerClosing;
    observer.emit({
      type: "pane-update",
      paneId: runtimeTab.zellijPaneId!,
      ansi: "late output",
      viewport: ["late output"],
      scrollback: [],
    });
    await checkpointStarted;
    releaseObserverClose();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    observer.emit({
      type: "pane-update",
      paneId: runtimeTab.zellijPaneId!,
      ansi: "too late",
      viewport: ["too late"],
      scrollback: [],
    });
    const finishedBeforeCheckpoint = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    expect(finishedBeforeCheckpoint).toBe(false);

    releaseCheckpoint();
    await shutdown;
    expect(await runtime.getSnapshot({ workspaceId: workspace.id, tabId: tab.id })).toMatchObject({
      ansi: "late output",
      viewport: ["late output"],
    });
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
