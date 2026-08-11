import {
  TerminalRefSchema,
  TerminalWorkspaceIdSchema,
  type TerminalRef,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  TerminalWorkspaceStore,
  type TerminalRuntimeWorkspaceState,
  type TerminalSnapshot,
} from "./workspace-store.js";

export interface ZellijRuntimeAdapter {
  ensureSession(sessionName: string, size?: { cols: number; rows: number }): Promise<void>;
  createTab(sessionName: string, input: {
    internalName: string;
    cwd: string;
    command?: string[];
  }): Promise<{ tabId: number; paneId: string }>;
  openAttachment(sessionName: string, input: {
    paneId: string;
    size: { cols: number; rows: number };
    onData: (data: Uint8Array) => void;
    onExit: (exitCode: number | null) => void;
  }): Promise<ZellijAttachment>;
  subscribeWorkspace(sessionName: string, input: {
    paneIds: string[];
    onEvent: (event: ZellijObserverEvent) => void;
  }): Promise<ZellijObserver>;
  findTabByInternalName?(sessionName: string, internalName: string): Promise<{ tabId: number; paneId: string } | undefined>;
  renameTab?(sessionName: string, tabId: number, name: string): Promise<void>;
  closeTab?(sessionName: string, tabId: number): Promise<void>;
  deleteSession?(sessionName: string): Promise<void>;
  resizeSession?(sessionName: string, size: { cols: number; rows: number }): Promise<void>;
  writeToPane?(sessionName: string, paneId: string, data: Uint8Array): Promise<void>;
}

export interface ZellijAttachment {
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export type ZellijObserverEvent =
  | { type: "pane-update"; paneId: string; ansi: string; viewport: string[]; scrollback: string[] }
  | { type: "pane-closed"; paneId: string };

export interface ZellijObserver {
  close(): Promise<void>;
}

export interface TerminalRuntimeOptions {
  store: TerminalWorkspaceStore;
  zellij: ZellijRuntimeAdapter;
  maxAttachments?: number;
  maxViewersPerTab?: number;
  maxPendingInputBytes?: number;
  viewerTtlMs?: number;
  sweepIntervalMs?: number;
}

export interface TerminalViewer {
  write(data: string): Promise<void>;
  touch(): void;
  detach(): Promise<void>;
}

interface ViewerState {
  id: string;
  lastTouched: number;
  send: (data: Uint8Array) => void | Promise<void>;
  onExit?: (exitCode: number | null) => void | Promise<void>;
}

interface AttachmentState {
  ref: TerminalRef;
  handle: ZellijAttachment;
  viewers: Map<string, ViewerState>;
}

interface InputQueueState {
  chain: Promise<void>;
  pendingBytes: number;
  lastTouched: number;
}

export class TerminalRuntime {
  private readonly store: TerminalWorkspaceStore;
  private readonly zellij: ZellijRuntimeAdapter;
  private readonly attachments = new Map<string, AttachmentState>();
  private readonly observers = new Map<string, ZellijObserver>();
  private readonly inputQueues = new Map<string, InputQueueState>();
  private readonly maxAttachments: number;
  private readonly maxViewersPerTab: number;
  private readonly maxPendingInputBytes: number;
  private readonly viewerTtlMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private checkpointChain: Promise<void> = Promise.resolve();

  constructor(options: TerminalRuntimeOptions) {
    this.store = options.store;
    this.zellij = options.zellij;
    this.maxAttachments = options.maxAttachments ?? 128;
    this.maxViewersPerTab = options.maxViewersPerTab ?? 8;
    this.maxPendingInputBytes = options.maxPendingInputBytes ?? 1024 * 1024;
    this.viewerTtlMs = options.viewerTtlMs ?? 2 * 60_000;
    this.sweepTimer = setInterval(() => { void this.sweepStaleViewers(); }, options.sweepIntervalMs ?? 30_000);
    this.sweepTimer.unref();
  }

  async ensureWorkspace(input: { projectId?: string } = {}): Promise<TerminalWorkspace> {
    const workspace = await this.store.ensureWorkspace(input);
    await this.reconcileWorkspace(workspace.id);
    return (await this.listWorkspaces()).find((candidate) => candidate.id === workspace.id)!;
  }

  async restoreAll(): Promise<void> {
    for (const workspace of await this.listWorkspaces()) {
      if (workspace.status !== "stopped") await this.reconcileWorkspace(workspace.id);
    }
  }

  async createTab(workspaceIdInput: string, input: {
    name: string;
    cwd: string;
    command?: string[];
    agent?: TerminalTab["agent"];
    git?: TerminalTab["git"];
  }): Promise<TerminalTab> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const runtimeWorkspace = await this.requireRuntimeWorkspace(workspaceId);
    await this.zellij.ensureSession(runtimeWorkspace.zellijSessionName, runtimeWorkspace.canonicalSize);
    const stagedTab = await this.store.createTab(workspaceId, input);
    const stagedWorkspace = await this.requireRuntimeWorkspace(workspaceId);
    const internalTab = stagedWorkspace.tabs[stagedTab.id];
    if (!internalTab) throw new Error("Terminal tab staging failed");
    const runtimeIds = await this.zellij.createTab(stagedWorkspace.zellijSessionName, {
      internalName: internalTab.zellijTabName,
      cwd: internalTab.cwd,
      ...(input.command ? { command: input.command } : {}),
    });
    const tab = await this.store.activateTab({ workspaceId, tabId: stagedTab.id }, runtimeIds);
    await this.restartObserver(workspaceId);
    return tab;
  }

  listWorkspaces(): Promise<TerminalWorkspace[]> {
    return this.store.listWorkspaces();
  }

  private async reconcileWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.requireRuntimeWorkspace(workspaceId);
    await this.zellij.ensureSession(workspace.zellijSessionName, workspace.canonicalSize);
    for (const tab of Object.values(workspace.tabs).sort((left, right) => left.order - right.order)) {
      if (tab.status === "exited" || tab.status === "failed") continue;
      let ids = await this.zellij.findTabByInternalName?.(workspace.zellijSessionName, tab.zellijTabName);
      ids ??= await this.zellij.createTab(workspace.zellijSessionName, {
        internalName: tab.zellijTabName,
        cwd: tab.cwd,
      });
      await this.store.activateTab({ workspaceId, tabId: tab.id }, ids);
    }
    await this.restartObserver(workspaceId);
  }

  async renameTab(refInput: TerminalRef, input: { name: string; baseRevision: number }): Promise<TerminalTab> {
    const ref = TerminalRefSchema.parse(refInput);
    const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
    const tab = workspace.tabs[ref.tabId];
    if (!tab || tab.zellijTabId === null || !this.zellij.renameTab) throw new Error("Terminal tab unavailable");
    await this.zellij.renameTab(workspace.zellijSessionName, tab.zellijTabId, input.name);
    return this.store.renameTab(ref, input);
  }

  reorderTabs(workspaceId: string, input: { tabIds: string[]; baseRevision: number }): Promise<TerminalWorkspace> {
    return this.store.reorderTabs(workspaceId, input);
  }

  updateTabUiState(ref: TerminalRef, input: {
    placement?: "active" | "background";
    lastSeenSeq?: number | null;
    baseRevision: number;
  }): Promise<TerminalTab> {
    return this.store.updateTabUiState(ref, input);
  }

  async resize(refInput: TerminalRef, input: {
    mode: "hard" | "soft";
    size: { cols: number; rows: number };
  }): Promise<TerminalWorkspace> {
    const ref = TerminalRefSchema.parse(refInput);
    const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
    if (!workspace.tabs[ref.tabId]) throw new Error("Terminal tab not found");
    if (input.mode === "soft") return (await this.listWorkspaces()).find((item) => item.id === ref.workspaceId)!;
    const updated = await this.store.updateCanonicalSize(ref.workspaceId, input.size);
    await this.zellij.resizeSession?.(workspace.zellijSessionName, updated.canonicalSize);
    await Promise.all([...this.attachments.values()]
      .filter((attachment) => attachment.ref.workspaceId === ref.workspaceId)
      .map((attachment) => attachment.handle.resize(updated.canonicalSize.cols, updated.canonicalSize.rows)));
    return updated;
  }

  async terminateTab(refInput: TerminalRef): Promise<void> {
    const ref = TerminalRefSchema.parse(refInput);
    const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
    const tab = workspace.tabs[ref.tabId];
    if (!tab || tab.zellijTabId === null || !this.zellij.closeTab) throw new Error("Terminal tab unavailable");
    await this.closeAttachment(refKey(ref));
    await this.zellij.closeTab(workspace.zellijSessionName, tab.zellijTabId);
    await this.store.markTabExited(ref);
    await this.restartObserver(ref.workspaceId);
  }

  async writeInput(refInput: TerminalRef, dataInput: string): Promise<void> {
    const ref = TerminalRefSchema.parse(refInput);
    await this.enqueueWrite(ref, dataInput, async (data) => {
      const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
      const tab = workspace.tabs[ref.tabId];
      if (!tab || tab.zellijPaneId === null || !this.zellij.writeToPane) {
        throw new Error("Terminal tab unavailable");
      }
      await this.zellij.writeToPane(workspace.zellijSessionName, tab.zellijPaneId, data);
    });
  }

  async deletionImpact(workspaceIdInput: string): Promise<{ runningTabs: number; tabs: TerminalTab[] }> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const workspace = (await this.listWorkspaces()).find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("Terminal workspace not found");
    const tabs = workspace.tabs.filter((tab) => tab.status === "running" || tab.status === "starting" || tab.status === "idle");
    return { runningTabs: tabs.length, tabs };
  }

  async deleteWorkspace(workspaceIdInput: string, input: { confirmTerminate: boolean }): Promise<void> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const impact = await this.deletionImpact(workspaceId);
    if (impact.runningTabs > 0 && !input.confirmTerminate) throw new Error("Terminal termination confirmation required");
    const workspace = await this.requireRuntimeWorkspace(workspaceId);
    if (!this.zellij.deleteSession) throw new Error("Terminal workspace deletion unavailable");
    for (const key of [...this.attachments.keys()]) {
      if (key.startsWith(`${workspaceId}:`)) await this.closeAttachment(key);
    }
    const observer = this.observers.get(workspaceId);
    if (observer) {
      this.observers.delete(workspaceId);
      await observer.close();
    }
    await this.zellij.deleteSession(workspace.zellijSessionName);
    await this.store.removeWorkspace(workspaceId);
  }

  async attach(refInput: TerminalRef, input: {
    viewerId: string;
    send: (data: Uint8Array) => void | Promise<void>;
    onExit?: (exitCode: number | null) => void | Promise<void>;
  }): Promise<TerminalViewer> {
    const ref = TerminalRefSchema.parse(refInput);
    const viewerId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).parse(input.viewerId);
    await this.sweepStaleViewers();
    const key = refKey(ref);
    let attachment = this.attachments.get(key);
    if (!attachment) {
      if (this.attachments.size >= this.maxAttachments) throw new Error("Terminal attachment capacity reached");
      const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
      const tab = workspace.tabs[ref.tabId];
      if (!tab || tab.zellijPaneId === null) throw new Error("Terminal tab unavailable");
      const next: AttachmentState = {
        ref,
        handle: undefined as unknown as ZellijAttachment,
        viewers: new Map(),
      };
      next.handle = await this.zellij.openAttachment(workspace.zellijSessionName, {
        paneId: tab.zellijPaneId,
        size: workspace.canonicalSize,
        onData: (data) => { void this.broadcast(key, data); },
        onExit: (exitCode) => { void this.handleAttachmentExit(key, exitCode); },
      });
      this.attachments.set(key, next);
      attachment = next;
    }
    if (!attachment.viewers.has(viewerId) && attachment.viewers.size >= this.maxViewersPerTab) {
      throw new Error("Terminal viewer capacity reached");
    }
    attachment.viewers.set(viewerId, {
      id: viewerId,
      lastTouched: Date.now(),
      send: input.send,
      ...(input.onExit ? { onExit: input.onExit } : {}),
    });
    let detached = false;
    return {
      write: async (data) => {
        if (detached) throw new Error("Terminal viewer detached");
        const viewer = attachment!.viewers.get(viewerId);
        if (!viewer) throw new Error("Terminal viewer unavailable");
        viewer.lastTouched = Date.now();
        await this.enqueueWrite(ref, data, (encoded) => attachment!.handle.write(encoded));
      },
      touch: () => {
        if (detached) return;
        const viewer = attachment!.viewers.get(viewerId);
        if (viewer) viewer.lastTouched = Date.now();
      },
      detach: async () => {
        if (detached) return;
        detached = true;
        attachment!.viewers.delete(viewerId);
        if (attachment!.viewers.size === 0) await this.closeAttachment(key);
      },
    };
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    await this.flushCheckpoints();
    await Promise.all([...this.observers.values()].map((observer) => observer.close()));
    this.observers.clear();
    await Promise.all([...this.attachments.keys()].map((key) => this.closeAttachment(key)));
    this.inputQueues.clear();
  }

  getSnapshot(ref: TerminalRef): Promise<TerminalSnapshot | undefined> {
    return this.store.readSnapshot(TerminalRefSchema.parse(ref));
  }

  async flushCheckpoints(): Promise<void> {
    await this.checkpointChain;
  }

  private async restartObserver(workspaceId: string): Promise<void> {
    const existing = this.observers.get(workspaceId);
    if (existing) {
      this.observers.delete(workspaceId);
      await existing.close();
    }
    const workspace = await this.requireRuntimeWorkspace(workspaceId);
    const paneRefs = new Map<string, TerminalRef>();
    for (const tab of Object.values(workspace.tabs)) {
      if (tab.zellijPaneId) paneRefs.set(tab.zellijPaneId, { workspaceId: workspace.id, tabId: tab.id });
    }
    if (paneRefs.size === 0) return;
    const observer = await this.zellij.subscribeWorkspace(workspace.zellijSessionName, {
      paneIds: [...paneRefs.keys()],
      onEvent: (event) => {
        const ref = paneRefs.get(event.paneId);
        if (!ref) return;
        if (event.type === "pane-closed") {
          const key = refKey(ref);
          this.checkpointChain = this.checkpointChain.then(async () => {
            if (this.attachments.has(key)) await this.handleAttachmentExit(key, null);
            else await this.store.markTabExited(ref);
          }).catch((error: unknown) => {
            console.error("[terminal-runtime] failed to record terminal tab exit", error);
          });
          return;
        }
        this.checkpointChain = this.checkpointChain
          .then(async () => { await this.store.checkpointTab(ref, event); })
          .catch((error: unknown) => {
            console.error("[terminal-runtime] failed to checkpoint terminal tab", error);
          });
      },
    });
    this.observers.set(workspaceId, observer);
  }

  private async enqueueWrite(
    ref: TerminalRef,
    dataInput: string,
    writer: (data: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const data = new TextEncoder().encode(z.string().min(1).max(64 * 1024).parse(dataInput));
    const key = refKey(ref);
    let queue = this.inputQueues.get(key);
    if (!queue) {
      if (this.inputQueues.size >= this.maxAttachments * 2) {
        const idle = [...this.inputQueues.entries()]
          .filter(([, candidate]) => candidate.pendingBytes === 0)
          .sort((left, right) => left[1].lastTouched - right[1].lastTouched)[0];
        if (!idle) throw new Error("Terminal input queue capacity reached");
        this.inputQueues.delete(idle[0]);
      }
      queue = { chain: Promise.resolve(), pendingBytes: 0, lastTouched: Date.now() };
      this.inputQueues.set(key, queue);
    }
    if (queue.pendingBytes + data.byteLength > this.maxPendingInputBytes) {
      throw new Error("Terminal input queue capacity reached");
    }
    queue.pendingBytes += data.byteLength;
    queue.lastTouched = Date.now();
    const write = queue.chain.then(() => writer(data));
    queue.chain = write.catch((error: unknown) => {
      console.error(
        "[terminal-runtime] serialized input write failed",
        error instanceof Error ? error.name : "unknown_error",
      );
    }).finally(() => {
      queue!.pendingBytes -= data.byteLength;
      queue!.lastTouched = Date.now();
    });
    await write;
  }

  private async broadcast(key: string, data: Uint8Array): Promise<void> {
    const attachment = this.attachments.get(key);
    if (!attachment) return;
    const failed: string[] = [];
    for (const viewer of attachment.viewers.values()) {
      try {
        await viewer.send(data);
      } catch (error) {
        console.error(
          "[terminal-runtime] viewer output send failed",
          error instanceof Error ? error.name : "unknown_error",
        );
        failed.push(viewer.id);
      }
    }
    for (const viewerId of failed) attachment.viewers.delete(viewerId);
    if (attachment.viewers.size === 0) await this.closeAttachment(key);
  }

  private async closeAttachment(key: string): Promise<void> {
    const attachment = this.attachments.get(key);
    if (!attachment) return;
    this.attachments.delete(key);
    attachment.viewers.clear();
    await attachment.handle.close();
  }

  private async handleAttachmentExit(key: string, exitCode: number | null): Promise<void> {
    const attachment = this.attachments.get(key);
    if (!attachment) return;
    const viewers = [...attachment.viewers.values()];
    await this.closeAttachment(key);
    await this.store.markTabExited(attachment.ref, exitCode).catch((error: unknown) => {
      console.error("[terminal-runtime] failed to persist terminal exit", error);
    });
    for (const viewer of viewers) {
      try { await viewer.onExit?.(exitCode); }
      catch (error) { console.error("[terminal-runtime] terminal exit delivery failed", error); }
    }
  }

  private async sweepStaleViewers(now = Date.now()): Promise<void> {
    for (const [key, attachment] of this.attachments) {
      for (const [viewerId, viewer] of attachment.viewers) {
        if (now - viewer.lastTouched > this.viewerTtlMs) attachment.viewers.delete(viewerId);
      }
      if (attachment.viewers.size === 0) await this.closeAttachment(key);
    }
  }

  private async requireRuntimeWorkspace(workspaceId: string): Promise<TerminalRuntimeWorkspaceState> {
    const workspace = await this.store.getRuntimeWorkspace(workspaceId);
    if (!workspace) throw new Error("Terminal workspace not found");
    return workspace;
  }
}

function refKey(ref: TerminalRef): string {
  return `${ref.workspaceId}:${ref.tabId}`;
}
