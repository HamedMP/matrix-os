import {
  TerminalRefSchema,
  TerminalPaneActionSchema,
  TerminalTabIdSchema,
  TerminalWorkspaceIdSchema,
  type TerminalPaneAction,
  type TerminalRef,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";
import { TerminalRuntimeError } from "./errors.js";
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
  findTabsByInternalName?(
    sessionName: string,
    internalNames: string[],
  ): Promise<Record<string, { tabId: number; paneId: string }>>;
  renameTab?(sessionName: string, tabId: number, name: string): Promise<void>;
  closeTab?(sessionName: string, tabId: number): Promise<void>;
  deleteSession?(sessionName: string): Promise<void>;
  resizeSession?(sessionName: string, size: { cols: number; rows: number }): Promise<void>;
  writeToPane?(sessionName: string, paneId: string, data: Uint8Array): Promise<void>;
  paneAction?(
    sessionName: string,
    tabId: number,
    paneId: string,
    action: TerminalPaneAction,
  ): Promise<void>;
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
  maxTabsPerWorkspace?: number;
  maxTabsTotal?: number;
  maxAttachments?: number;
  maxObservers?: number;
  maxViewersPerTab?: number;
  maxPendingInputBytes?: number;
  viewerTtlMs?: number;
  sweepIntervalMs?: number;
  observerCloseTimeoutMs?: number;
}
export interface TerminalViewer {
  write(data: string | Uint8Array): Promise<void>;
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

interface ObserverState extends ZellijObserver {
  readonly size: number;
  add(observer: ZellijObserver, restore: () => Promise<ZellijObserver>): void;
  restore(): Promise<ObserverState>;
}

function tabOccupiesAdmission(tab: TerminalTab): boolean {
  return tab.status !== "exited" && tab.status !== "failed";
}

export class TerminalRuntime {
  private readonly store: TerminalWorkspaceStore;
  private readonly zellij: ZellijRuntimeAdapter;
  private readonly maxTabsPerWorkspace: number;
  private readonly maxTabsTotal: number;
  private readonly attachments = new Map<string, AttachmentState>();
  private readonly observers = new Map<string, ObserverState>();
  private readonly observerReservations = new Map<string, number>();
  private readonly inputQueues = new Map<string, InputQueueState>();
  private readonly terminatingTabKeys = new Set<string>();
  private readonly closingPaneTabKeys = new Map<string, number>();
  private readonly maxAttachments: number;
  private readonly maxObservers: number;
  private readonly maxViewersPerTab: number;
  private readonly maxPendingInputBytes: number;
  private readonly viewerTtlMs: number;
  private readonly observerCloseTimeoutMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private checkpointChain: Promise<void> = Promise.resolve();
  private observerChain: Promise<void> = Promise.resolve();
  private workspaceMutationChain: Promise<void> = Promise.resolve();
  // Workspace mutations are globally serialized, so at most one deletion can
  // own write admission at a time.
  private deletingWorkspaceId: string | null = null;
  private untrackedPaneClosures = 0;
  private observerRetryQueued = false;
  private shuttingDown = false;
  private acceptingObserverEvents = true;

  constructor(options: TerminalRuntimeOptions) {
    this.store = options.store;
    this.zellij = options.zellij;
    this.maxTabsPerWorkspace = z.number().int().min(1).max(10_000).parse(options.maxTabsPerWorkspace ?? 64);
    this.maxTabsTotal = z.number().int().min(this.maxTabsPerWorkspace).max(10_000)
      .parse(options.maxTabsTotal ?? 256);
    this.maxAttachments = options.maxAttachments ?? 128;
    this.maxObservers = z.number().int().min(1).max(1_024).parse(options.maxObservers ?? 128);
    this.maxViewersPerTab = options.maxViewersPerTab ?? 8;
    this.maxPendingInputBytes = options.maxPendingInputBytes ?? 1024 * 1024;
    this.viewerTtlMs = options.viewerTtlMs ?? 2 * 60_000;
    this.observerCloseTimeoutMs = z.number().int().min(1).max(30_000).parse(options.observerCloseTimeoutMs ?? 5_000);
    this.sweepTimer = setInterval(() => {
      void this.sweepStaleViewers().catch((error: unknown) => {
        console.error("[terminal-runtime] stale viewer sweep failed", error instanceof Error ? error.name : "unknown_error");
      });
      this.queueMissingObserverRetry();
    }, options.sweepIntervalMs ?? 30_000);
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
    tabId?: string;
    name: string;
    cwd: string;
    command?: string[];
    agent?: TerminalTab["agent"];
    git?: TerminalTab["git"];
    accessScope?: TerminalTab["accessScope"];
  }): Promise<TerminalTab> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const requestedTabId = input.tabId ? TerminalTabIdSchema.parse(input.tabId) : undefined;
    return this.runWorkspaceMutation(async () => {
      const existing = requestedTabId
        ? await this.store.getTab({ workspaceId, tabId: requestedTabId })
        : undefined;
      if (existing && existing.status !== "starting") return existing;
      const workspaces = await this.listWorkspaces();
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) throw new TerminalRuntimeError("not_found");
      if (!existing && workspace.tabs.filter(tabOccupiesAdmission).length >= this.maxTabsPerWorkspace) {
        throw new TerminalRuntimeError("capacity");
      }
      if (!existing && workspaces.reduce(
        (count, candidate) => count + candidate.tabs.filter(tabOccupiesAdmission).length,
        0,
      ) >= this.maxTabsTotal) {
        throw new TerminalRuntimeError("capacity");
      }
      const releaseObserverReservation = this.reserveObserverSlot(workspaceId);
      let stagedTab: TerminalTab | undefined = existing;
      let runtimeIds: { tabId: number; paneId: string } | undefined;
      let createdRuntimeTab = false;
      let sessionName: string | undefined;
      let startupCommand: string[] = [];
      try {
        const runtimeWorkspace = await this.requireRuntimeWorkspace(workspaceId);
        sessionName = runtimeWorkspace.zellijSessionName;
        await this.zellij.ensureSession(runtimeWorkspace.zellijSessionName, runtimeWorkspace.canonicalSize);
        stagedTab ??= await this.store.createTab(workspaceId, {
          ...input,
          accessScope: input.accessScope ?? "owner",
        });
        const stagedWorkspace = await this.requireRuntimeWorkspace(workspaceId);
        const internalTab = stagedWorkspace.tabs[stagedTab.id];
        if (!internalTab) throw new Error("Terminal tab staging failed");
        startupCommand = internalTab.startupCommand ?? input.command ?? [];
        runtimeIds = existing
          ? await this.zellij.findTabByInternalName?.(stagedWorkspace.zellijSessionName, internalTab.zellijTabName)
          : undefined;
        if (!runtimeIds) {
          runtimeIds = await this.zellij.createTab(stagedWorkspace.zellijSessionName, {
            internalName: internalTab.zellijTabName,
            cwd: internalTab.cwd,
            ...(startupCommand?.length ? { command: startupCommand } : {}),
          });
          createdRuntimeTab = true;
        }
        const tab = await this.store.activateTab({ workspaceId, tabId: stagedTab.id }, runtimeIds);
        await this.restartObserver(workspaceId);
        return tab;
      } catch (error) {
        if (stagedTab && sessionName && (!existing || createdRuntimeTab)) {
          try {
            await this.rollbackTabCreation(sessionName, {
              workspaceId,
              tabId: stagedTab.id,
            }, runtimeIds?.tabId, existing ? startupCommand : undefined);
          } catch (rollbackError) {
            console.error(
              "[terminal-runtime] failed to roll back terminal tab creation",
              rollbackError instanceof Error ? rollbackError.name : "unknown_error",
            );
          }
        }
        throw error;
      } finally {
        releaseObserverReservation();
      }
    });
  }

  listWorkspaces(): Promise<TerminalWorkspace[]> {
    return this.store.listWorkspaces();
  }

  private reconcileWorkspace(workspaceId: string): Promise<void> {
    return this.runWorkspaceMutation(() => this.reconcileWorkspaceNow(workspaceId));
  }

  private async reconcileWorkspaceNow(workspaceId: string): Promise<void> {
    const workspace = await this.requireRuntimeWorkspace(workspaceId);
    const needsObserver = Object.values(workspace.tabs)
      .some((tab) => (
        tab.status === "starting"
          ? tab.startupCommand !== undefined
          : tab.status !== "exited" && tab.status !== "failed"
      ));
    const releaseObserverReservation = needsObserver
      ? this.reserveObserverSlot(workspaceId)
      : () => undefined;
    try {
      await this.zellij.ensureSession(workspace.zellijSessionName, workspace.canonicalSize);
      const restorableTabs = Object.values(workspace.tabs)
        .filter((tab) => tab.status !== "exited" && tab.status !== "failed")
        .sort((left, right) => left.order - right.order);
      const recoveredTabs = restorableTabs.length > 0 && this.zellij.findTabsByInternalName
        ? await this.zellij.findTabsByInternalName(
            workspace.zellijSessionName,
            restorableTabs.map((tab) => tab.zellijTabName),
          )
        : undefined;
      for (const tab of restorableTabs) {
        let ids = recoveredTabs
          ? recoveredTabs[tab.zellijTabName]
          : await this.zellij.findTabByInternalName?.(workspace.zellijSessionName, tab.zellijTabName);
        if (tab.status === "starting" && tab.startupCommand === undefined) {
          // Records without startup intent predate stable client-supplied tab
          // IDs. Recover an already-created Zellij tab when possible; an
          // absent one cannot be retried by a client and must stop consuming
          // admission capacity.
          if (ids) await this.store.activateTab({ workspaceId, tabId: tab.id }, ids);
          else await this.store.markTabExited({ workspaceId, tabId: tab.id });
          continue;
        }
        if (!ids) {
          if (tab.status !== "starting") {
            await this.store.markTabExited({ workspaceId, tabId: tab.id });
            continue;
          }
          ids = await this.zellij.createTab(workspace.zellijSessionName, {
            internalName: tab.zellijTabName,
            cwd: tab.cwd,
            ...(tab.startupCommand?.length ? { command: tab.startupCommand } : {}),
          });
        }
        await this.store.activateTab({ workspaceId, tabId: tab.id }, ids);
      }
      await this.restartObserver(workspaceId);
    } finally {
      releaseObserverReservation();
    }
  }

  async renameTab(refInput: TerminalRef, input: { name: string; baseRevision: number }): Promise<TerminalTab> {
    const ref = TerminalRefSchema.parse(refInput);
    const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
    const tab = workspace.tabs[ref.tabId];
    if (!tab || tab.zellijTabId === null) throw new TerminalRuntimeError("not_found");
    if (!this.zellij.renameTab) throw new TerminalRuntimeError("unavailable");
    await this.zellij.renameTab(workspace.zellijSessionName, tab.zellijTabId, input.name);
    return this.store.renameTab(ref, input);
  }

  reorderTabs(workspaceId: string, input: { tabIds: string[]; baseRevision: number }): Promise<TerminalWorkspace> {
    return this.store.reorderTabs(workspaceId, input);
  }

  updateTabUiState(ref: TerminalRef, input: {
    placement?: "active" | "background";
    lastSeenSeq?: number | null;
    pinned?: boolean;
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
    if (!workspace.tabs[ref.tabId]) throw new TerminalRuntimeError("not_found");
    if (input.mode === "soft") return (await this.listWorkspaces()).find((item) => item.id === ref.workspaceId)!;
    const updated = await this.store.updateCanonicalSize(ref.workspaceId, input.size);
    await this.zellij.resizeSession?.(workspace.zellijSessionName, updated.canonicalSize);
    await Promise.all([...this.attachments.values()]
      .filter((attachment) => attachment.ref.workspaceId === ref.workspaceId)
      .map((attachment) => attachment.handle.resize(updated.canonicalSize.cols, updated.canonicalSize.rows)));
    return updated;
  }

  async terminateTab(refInput: TerminalRef): Promise<void> {
    await this.finishTab(refInput, false);
  }

  async deleteTab(refInput: TerminalRef): Promise<void> {
    await this.finishTab(refInput, true);
  }

  private async finishTab(refInput: TerminalRef, removeCanonicalRecord: boolean): Promise<void> {
    const ref = TerminalRefSchema.parse(refInput);
    const key = refKey(ref);
    if (this.terminatingTabKeys.has(key)) throw new TerminalRuntimeError("conflict");
    if (this.terminatingTabKeys.size >= this.maxAttachments * 2) {
      throw new TerminalRuntimeError("capacity");
    }
    this.terminatingTabKeys.add(key);
    try {
      await this.runWorkspaceMutation(async () => {
        const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
        const tab = workspace.tabs[ref.tabId];
        if (!tab) throw new TerminalRuntimeError("not_found");
        const terminalAlreadyExited = tab.status === "exited" || tab.status === "failed";
        let zellijTabId = terminalAlreadyExited ? null : tab.zellijTabId;
        if (removeCanonicalRecord && terminalAlreadyExited) {
          if (!this.zellij.findTabByInternalName) throw new TerminalRuntimeError("unavailable");
          zellijTabId = (await this.zellij.findTabByInternalName(
            workspace.zellijSessionName,
            tab.zellijTabName,
          ))?.tabId ?? null;
        }
        if (zellijTabId === null && tab.status === "starting") {
          if (!this.zellij.findTabByInternalName) throw new TerminalRuntimeError("unavailable");
          zellijTabId = (await this.zellij.findTabByInternalName(
            workspace.zellijSessionName,
            tab.zellijTabName,
          ))?.tabId ?? null;
        }
        if (zellijTabId !== null && !this.zellij.closeTab) {
          throw new TerminalRuntimeError("unavailable");
        }
        await this.drainTabInput(key);
        await this.closeAttachment(key, true);
        if (zellijTabId !== null) {
          await this.zellij.closeTab!(workspace.zellijSessionName, zellijTabId);
        }
        if (removeCanonicalRecord) await this.store.removeTab(ref);
        else await this.store.markTabExited(ref);
        await this.restartObserver(ref.workspaceId);
      });
    } finally {
      this.terminatingTabKeys.delete(key);
    }
  }

  async writeInput(refInput: TerminalRef, dataInput: string): Promise<void> {
    const ref = TerminalRefSchema.parse(refInput);
    await this.enqueueWrite(ref, dataInput, async (data) => {
      const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
      const tab = workspace.tabs[ref.tabId];
      if (!tab || tab.zellijPaneId === null) throw new TerminalRuntimeError("not_found");
      if (
        (tab.status !== "running" && tab.status !== "idle") ||
        !this.zellij.writeToPane
      ) throw new TerminalRuntimeError("unavailable");
      await this.zellij.writeToPane(workspace.zellijSessionName, tab.zellijPaneId, data);
    });
  }

  async paneAction(refInput: TerminalRef, actionInput: TerminalPaneAction): Promise<void> {
    const ref = TerminalRefSchema.parse(refInput);
    const action = TerminalPaneActionSchema.parse(actionInput);
    await this.runWorkspaceMutation(async () => {
      const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
      const tab = workspace.tabs[ref.tabId];
      if (
        !tab
        || tab.zellijTabId === null
        || tab.zellijPaneId === null
        || !this.zellij.paneAction
      ) {
        throw new Error("Terminal tab unavailable");
      }
      await this.zellij.paneAction(
        workspace.zellijSessionName,
        tab.zellijTabId,
        tab.zellijPaneId,
        action,
      );
    });
  }

  async deletionImpact(workspaceIdInput: string): Promise<{ runningTabs: number; tabs: TerminalTab[] }> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const workspace = (await this.listWorkspaces()).find((item) => item.id === workspaceId);
    if (!workspace) throw new TerminalRuntimeError("not_found");
    const tabs = workspace.tabs.filter((tab) => tab.status === "running" || tab.status === "starting" || tab.status === "idle");
    return { runningTabs: tabs.length, tabs };
  }

  async deleteWorkspace(workspaceIdInput: string, input: { confirmTerminate: boolean }): Promise<void> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    await this.runWorkspaceMutation(async () => {
      const impact = await this.deletionImpact(workspaceId);
      if (impact.runningTabs > 0 && !input.confirmTerminate) {
        throw new TerminalRuntimeError("confirmation_required");
      }
      const workspace = await this.requireRuntimeWorkspace(workspaceId);
      if (!this.zellij.deleteSession) throw new TerminalRuntimeError("unavailable");
      this.deletingWorkspaceId = workspaceId;
      try {
        await this.drainWorkspaceInput(workspaceId);
        for (const key of [...this.attachments.keys()]) {
          if (key.startsWith(`${workspaceId}:`)) await this.closeAttachment(key, true);
        }
        const operation = this.observerChain.then(async () => {
          const observer = this.observers.get(workspaceId);
          if (observer) {
            await observer.close();
            if (this.observers.get(workspaceId) === observer) this.observers.delete(workspaceId);
          }
          await this.zellij.deleteSession!(workspace.zellijSessionName);
          await this.store.removeWorkspace(workspaceId);
        });
        this.observerChain = operation.catch((error: unknown) => {
          console.error(
            "[terminal-runtime] failed to delete terminal workspace",
            error instanceof Error ? error.name : "unknown_error",
          );
        });
        await operation;
      } finally {
        if (this.deletingWorkspaceId === workspaceId) this.deletingWorkspaceId = null;
      }
    });
  }

  attach(refInput: TerminalRef, input: {
    viewerId: string;
    send: (data: Uint8Array) => void | Promise<void>;
    onExit?: (exitCode: number | null) => void | Promise<void>;
  }): Promise<TerminalViewer> {
    return this.runWorkspaceMutation(() => this.attachNow(refInput, input));
  }

  private async attachNow(refInput: TerminalRef, input: {
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
      if (this.attachments.size >= this.maxAttachments) throw new TerminalRuntimeError("capacity");
      const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
      const tab = workspace.tabs[ref.tabId];
      if (!tab || tab.zellijPaneId === null) throw new TerminalRuntimeError("not_found");
      const next: AttachmentState = {
        ref,
        handle: undefined as unknown as ZellijAttachment,
        viewers: new Map(),
      };
      let openingExit: { exitCode: number | null; release: () => void } | undefined;
      try {
        next.handle = await this.zellij.openAttachment(workspace.zellijSessionName, {
          paneId: tab.zellijPaneId,
          size: workspace.canonicalSize,
          onData: (data) => { void this.broadcast(key, data); },
          onExit: (exitCode) => {
            if (!this.attachments.has(key)) { openingExit ??= { exitCode, release: this.reservePaneClosure(key) }; return; }
            const releasePaneClosure = this.reservePaneClosure(key);
            void this.handleAttachmentExit(key, exitCode)
              .catch((error: unknown) => { console.error("[terminal-runtime] failed to record terminal attachment exit", error); })
              .finally(releasePaneClosure);
          },
        });
        this.attachments.set(key, next);
        if (openingExit) { await this.handleAttachmentExit(key, openingExit.exitCode); throw new Error("Terminal tab unavailable"); }
      } finally { openingExit?.release(); }
      attachment = next;
    }
    if (!attachment.viewers.has(viewerId) && attachment.viewers.size >= this.maxViewersPerTab) {
      throw new TerminalRuntimeError("capacity");
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
        if (detached) throw new TerminalRuntimeError("conflict");
        const viewer = attachment!.viewers.get(viewerId);
        if (!viewer) throw new TerminalRuntimeError("unavailable");
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
    this.shuttingDown = true;
    clearInterval(this.sweepTimer);
    await this.workspaceMutationChain;
    await this.observerChain;
    const observerEntries = [...this.observers.entries()];
    const observerResults = await Promise.allSettled(observerEntries.map(([, observer]) => Promise.race([
      observer.close(),
      delay(this.observerCloseTimeoutMs, undefined, { ref: false }).then(() => {
        throw new Error("Terminal observer close timed out");
      }),
    ])));
    this.acceptingObserverEvents = false;
    observerResults.forEach((result, index) => {
      const entry = observerEntries[index];
      if (result.status === "fulfilled" && entry && this.observers.get(entry[0]) === entry[1]) this.observers.delete(entry[0]);
    });
    await this.flushCheckpoints();
    await Promise.all([...this.inputQueues.values()].map((queue) => queue.chain));
    await Promise.all([...this.attachments.keys()].map((key) => this.closeAttachment(key, true)));
    this.inputQueues.clear();
    this.closingPaneTabKeys.clear();
    this.untrackedPaneClosures = 0;
    const observerFailure = observerResults.find((result) => result.status === "rejected");
    if (observerFailure?.status === "rejected") throw observerFailure.reason;
  }

  getSnapshot(ref: TerminalRef): Promise<TerminalSnapshot | undefined> {
    return this.store.readSnapshot(TerminalRefSchema.parse(ref));
  }

  async flushCheckpoints(): Promise<void> {
    await this.checkpointChain;
  }

  private runWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new TerminalRuntimeError("unavailable"));
    const result = this.workspaceMutationChain.then(operation);
    this.workspaceMutationChain = result.then(
      () => undefined,
      (error: unknown) => {
        console.error(
          "[terminal-runtime] workspace mutation failed",
          error instanceof Error ? error.name : "unknown_error",
        );
      },
    );
    return result;
  }

  private async rollbackTabCreation(
    sessionName: string,
    ref: TerminalRef,
    zellijTabId?: number,
    recoveryCommand?: string[],
  ): Promise<void> {
    if (recoveryCommand) {
      await this.store.restoreTabStartupIntent(ref, recoveryCommand);
      if (zellijTabId !== undefined) {
        if (!this.zellij.closeTab) throw new Error("Terminal tab rollback unavailable");
        await this.zellij.closeTab(sessionName, zellijTabId);
      }
      return;
    }
    try {
      if (zellijTabId !== undefined) {
        if (!this.zellij.closeTab) throw new Error("Terminal tab rollback unavailable");
        await this.zellij.closeTab(sessionName, zellijTabId);
      }
    } finally {
      await this.store.removeTab(ref);
    }
  }

  private async restartObserver(workspaceId: string): Promise<void> {
    const operation = this.observerChain.then(async () => { await this.replaceObserver(workspaceId); });
    this.observerChain = operation.catch((error: unknown) => {
      console.error(
        "[terminal-runtime] failed to restart workspace observer",
        error instanceof Error ? error.name : "unknown_error",
      );
    });
    await operation;
  }

  private async replaceObserver(workspaceId: string): Promise<void> {
    let existing = this.observers.get(workspaceId);
    const workspace = await this.requireRuntimeWorkspace(workspaceId);
    const paneRefs = new Map<string, TerminalRef>();
    for (const tab of Object.values(workspace.tabs)) {
      if (tab.zellijPaneId) paneRefs.set(tab.zellijPaneId, { workspaceId: workspace.id, tabId: tab.id });
    }
    if (paneRefs.size === 0) {
      if (existing) {
        await existing.close();
        if (this.observers.get(workspaceId) === existing) this.observers.delete(workspaceId);
      }
      return;
    }
    let closedForCapacity: ObserverState | undefined;
    if (existing && this.observerCount() >= this.maxObservers) {
      await existing.close();
      if (this.observers.get(workspaceId) === existing) this.observers.delete(workspaceId);
      closedForCapacity = existing;
      existing = undefined;
    }
    if (!existing && !this.observerReservations.has(workspaceId) && this.observerCount() >= this.maxObservers) {
      throw new TerminalRuntimeError("capacity");
    }
    const observerInput = {
      paneIds: [...paneRefs.keys()],
      onEvent: (event: ZellijObserverEvent) => {
        if (!this.acceptingObserverEvents) return;
        const ref = paneRefs.get(event.paneId);
        if (!ref) return;
        if (event.type === "pane-closed") {
          const key = refKey(ref);
          const releasePaneClosure = this.reservePaneClosure(key);
          this.checkpointChain = this.checkpointChain.then(async () => {
            try {
              await this.drainTabInput(key);
              await this.retryPaneClosureCheckpoint(() => this.reconcileObservedPaneClose(ref));
            } finally {
              releasePaneClosure();
            }
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
    };
    const subscribeObserver = () => this.zellij.subscribeWorkspace(workspace.zellijSessionName, observerInput);
    let replacement: ZellijObserver;
    try {
      replacement = await subscribeObserver();
    } catch (error) {
      if (closedForCapacity) {
        try {
          this.observers.set(workspaceId, await closedForCapacity.restore());
        } catch (restoreError) {
          this.observers.set(workspaceId, closedForCapacity);
          this.queueMissingObserverRetry();
          throw new AggregateError([error, restoreError], "Terminal observer restoration failed");
        }
      }
      throw error;
    }
    if (existing) {
      try {
        await existing.close();
      } catch (error) {
        try {
          await replacement.close();
        } catch (replacementError) {
          existing.add(replacement, subscribeObserver);
          throw new AggregateError([error, replacementError], "Terminal observer replacement cleanup failed");
        }
        throw error;
      }
    }
    this.observers.set(workspaceId, createObserverState(replacement, subscribeObserver));
  }

  private observerCount(): number {
    return [...this.observers.values()].reduce((count, observer) => count + Math.max(1, observer.size), 0);
  }

  private queueMissingObserverRetry(): void {
    if (this.shuttingDown || this.observerRetryQueued) return;
    this.observerRetryQueued = true;
    const operation = this.observerChain.then(async () => {
      for (const [workspaceId, observer] of this.observers) {
        if (observer.size > 0) continue;
        try {
          const restored = await observer.restore();
          if (this.observers.get(workspaceId) === observer) this.observers.set(workspaceId, restored);
          else await restored.close();
        } catch (error) {
          console.error(
            "[terminal-runtime] failed to restore workspace observer",
            error instanceof Error ? error.name : "unknown_error",
          );
        }
      }
    });
    this.observerChain = operation.then(
      () => { this.observerRetryQueued = false; },
      (error: unknown) => {
        this.observerRetryQueued = false;
        console.error("[terminal-runtime] observer retry failed", error instanceof Error ? error.name : "unknown_error");
      },
    );
  }

  private async reconcileObservedPaneClose(ref: TerminalRef): Promise<void> {
    await this.runWorkspaceMutation(async () => {
      const workspace = await this.requireRuntimeWorkspace(ref.workspaceId);
      const tab = workspace.tabs[ref.tabId];
      if (!tab || tab.status === "exited" || tab.status === "failed") return;
      const replacement = await this.zellij.findTabByInternalName?.(
        workspace.zellijSessionName,
        tab.zellijTabName,
      );
      if (replacement) {
        await this.store.activateTab(ref, replacement);
      } else {
        const key = refKey(ref);
        if (this.attachments.has(key)) await this.handleAttachmentExit(key, null);
        else await this.store.markTabExited(ref);
      }
      await this.restartObserver(ref.workspaceId);
    });
  }

  private reserveObserverSlot(workspaceId: string): () => void {
    if (this.observers.has(workspaceId)) return () => undefined;
    const currentReservations = this.observerReservations.get(workspaceId);
    if (currentReservations !== undefined) {
      this.observerReservations.set(workspaceId, currentReservations + 1);
    } else {
      if (this.observerCount() + this.observerReservations.size >= this.maxObservers) {
        throw new TerminalRuntimeError("capacity");
      }
      this.observerReservations.set(workspaceId, 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const reservations = this.observerReservations.get(workspaceId);
      if (reservations === undefined || reservations <= 1) this.observerReservations.delete(workspaceId);
      else this.observerReservations.set(workspaceId, reservations - 1);
    };
  }

  private async enqueueWrite(
    ref: TerminalRef,
    dataInput: string | Uint8Array,
    writer: (data: Uint8Array) => Promise<void>,
  ): Promise<void> {
    if (this.shuttingDown) throw new TerminalRuntimeError("unavailable");
    if (this.deletingWorkspaceId === ref.workspaceId) {
      throw new TerminalRuntimeError("conflict", "Terminal workspace deletion in progress");
    }
    const data = typeof dataInput === "string"
      ? new TextEncoder().encode(z.string().min(1).max(64 * 1024).parse(dataInput))
      : Uint8Array.from(dataInput);
    if (data.byteLength < 1 || data.byteLength > 64 * 1024) {
      throw new TerminalRuntimeError("invalid_request");
    }
    const key = refKey(ref);
    this.assertTabAcceptsInput(key);
    let queue = this.inputQueues.get(key);
    if (!queue) {
      if (this.inputQueues.size >= this.maxAttachments * 2) {
        const idle = [...this.inputQueues.entries()]
          .filter(([, candidate]) => candidate.pendingBytes === 0)
          .sort((left, right) => left[1].lastTouched - right[1].lastTouched)[0];
        if (!idle) throw new TerminalRuntimeError("capacity");
        this.inputQueues.delete(idle[0]);
      }
      queue = { chain: Promise.resolve(), pendingBytes: 0, lastTouched: Date.now() };
      this.inputQueues.set(key, queue);
    }
    if (queue.pendingBytes + data.byteLength > this.maxPendingInputBytes) {
      throw new TerminalRuntimeError("capacity");
    }
    queue.pendingBytes += data.byteLength;
    queue.lastTouched = Date.now();
    const write = queue.chain.then(() => {
      // Admission gates are checked before the write joins this queue. Once
      // admitted, the write must drain before termination, deletion, or
      // shutdown closes the underlying runtime resource.
      return writer(data);
    });
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

  private assertTabAcceptsInput(key: string): void {
    if (this.terminatingTabKeys.has(key)) {
      throw new TerminalRuntimeError("conflict", "Terminal tab termination in progress");
    }
    if (this.closingPaneTabKeys.has(key) || this.untrackedPaneClosures > 0) {
      throw new TerminalRuntimeError("conflict", "Terminal tab closure in progress");
    }
  }

  private reservePaneClosure(key: string): () => void {
    let released = false;
    const releaseOnce = (release: () => void) => () => {
      if (released) return;
      released = true;
      release();
    };
    const existing = this.closingPaneTabKeys.get(key);
    if (existing !== undefined) {
      this.closingPaneTabKeys.set(key, existing + 1);
      return releaseOnce(() => this.releasePaneClosure(key));
    }
    if (this.closingPaneTabKeys.size < this.maxAttachments * 2) {
      this.closingPaneTabKeys.set(key, 1);
      return releaseOnce(() => this.releasePaneClosure(key));
    }
    this.untrackedPaneClosures += 1;
    return releaseOnce(() => { this.untrackedPaneClosures -= 1; });
  }

  private releasePaneClosure(key: string): void {
    const count = this.closingPaneTabKeys.get(key);
    if (count === undefined) return;
    if (count === 1) this.closingPaneTabKeys.delete(key);
    else this.closingPaneTabKeys.set(key, count - 1);
  }

  private async drainWorkspaceInput(workspaceId: string): Promise<void> {
    const prefix = `${workspaceId}:`;
    const queues = [...this.inputQueues.entries()]
      .filter(([key]) => key.startsWith(prefix));
    await Promise.all(queues.map(([, queue]) => queue.chain));
    for (const [key, queue] of queues) {
      if (queue.pendingBytes === 0 && this.inputQueues.get(key) === queue) {
        this.inputQueues.delete(key);
      }
    }
  }

  private async drainTabInput(key: string): Promise<void> {
    const queue = this.inputQueues.get(key);
    if (!queue) return;
    await queue.chain;
    if (queue.pendingBytes === 0 && this.inputQueues.get(key) === queue) {
      this.inputQueues.delete(key);
    }
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

  private async closeAttachment(key: string, force = false): Promise<void> {
    const attachment = this.attachments.get(key);
    if (!attachment) return;
    const releasePaneClosure = this.reservePaneClosure(key);
    try {
      await this.drainTabInput(key);
      if (this.attachments.get(key) !== attachment) return;
      if (!force && attachment.viewers.size > 0) return;
      this.attachments.delete(key);
      attachment.viewers.clear();
      await attachment.handle.close();
    } finally {
      releasePaneClosure();
    }
  }

  private async handleAttachmentExit(key: string, exitCode: number | null): Promise<void> {
    const attachment = this.attachments.get(key);
    if (!attachment) return;
    await this.drainTabInput(key);
    const viewers = [...attachment.viewers.values()];
    let closeFailure: unknown;
    try { await this.closeAttachment(key, true); }
    catch (error: unknown) { closeFailure = error; }
    let persistenceFailure: unknown;
    try {
      await this.retryPaneClosureCheckpoint(() => this.store.markTabExited(attachment.ref, exitCode));
    }
    catch (error: unknown) { persistenceFailure = error; }
    for (const viewer of viewers) {
      try { await viewer.onExit?.(exitCode); }
      catch (error) { console.error("[terminal-runtime] terminal exit delivery failed", error); }
    }
    if (persistenceFailure) throw persistenceFailure;
    if (closeFailure) throw closeFailure;
  }

  private async retryPaneClosureCheckpoint(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      console.warn(
        "[terminal-runtime] retrying terminal pane closure checkpoint",
        error instanceof Error ? error.name : "unknown_error",
      );
      await operation();
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
    if (!workspace) throw new TerminalRuntimeError("not_found");
    return workspace;
  }
}

function createObserverState(
  initialObserver: ZellijObserver,
  initialRestore: () => Promise<ZellijObserver>,
): ObserverState {
  const observers = new Set([initialObserver]);
  let restoreObserver = initialRestore;
  return {
    get size() { return observers.size; },
    add: (observer, restore) => {
      observers.add(observer);
      restoreObserver = restore;
    },
    restore: async () => createObserverState(await restoreObserver(), restoreObserver),
    close: async () => {
      const current = [...observers];
      const results = await Promise.allSettled(current.map((observer) => observer.close()));
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") observers.delete(current[index]!);
      }
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

function refKey(ref: TerminalRef): string {
  return `${ref.workspaceId}:${ref.tabId}`;
}
