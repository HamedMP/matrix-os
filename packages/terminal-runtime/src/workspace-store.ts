import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ProjectIdSchema,
  SafeDisplayStringSchema,
  TerminalGridSizeSchema,
  TerminalRefSchema,
  TerminalTabIdSchema,
  TerminalTabSchema,
  TerminalWorkspaceIdSchema,
  TerminalWorkspaceSchema,
  type TerminalRef,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_ANSI_BYTES = 5 * 1024 * 1024;
// Zellij's ANSI string and its line arrays describe the same retained output.
// JSON can expand each control character to six bytes (for example `\\u0001`),
// so reserve that worst case for both representations plus bounded envelope
// overhead. This remains a finite per-tab disk/read limit.
const MAX_SNAPSHOT_BYTES = (MAX_SNAPSHOT_ANSI_BYTES * 6 * 2) + (4 * 1024 * 1024);
const DEFAULT_SIZE = { cols: 120, rows: 36 } as const;
const InternalTabSchema = TerminalTabSchema.omit({}).extend({
  zellijTabName: z.string().regex(/^matrix-tab-[0-9a-f]{32}$/),
  zellijTabId: z.number().int().min(0).nullable(),
  zellijPaneId: z.string().regex(/^terminal_[0-9]+$/).nullable(),
  migrationKey: z.string().min(1).max(256).optional(),
}).strict();
const InternalWorkspaceBaseSchema = z.object({
  id: TerminalWorkspaceIdSchema,
  zellijSessionName: z.string().regex(/^matrix-w-[0-9a-f]{32}$/),
  canonicalSize: TerminalGridSizeSchema,
  status: z.enum(["maintenance", "starting", "running", "degraded", "stopped"]),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  tabs: z.record(TerminalTabIdSchema, InternalTabSchema),
});
const InternalWorkspaceSchema = z.discriminatedUnion("scope", [
  InternalWorkspaceBaseSchema.extend({ scope: z.literal("main") }).strict(),
  InternalWorkspaceBaseSchema.extend({ scope: z.literal("project"), projectId: ProjectIdSchema }).strict(),
]);
const StateSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  workspaces: z.record(TerminalWorkspaceIdSchema, InternalWorkspaceSchema),
}).strict();
const SnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  terminalRef: TerminalRefSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ansi: z.string().max(MAX_SNAPSHOT_ANSI_BYTES),
  viewport: z.array(z.string().max(16_384)).max(200),
  scrollback: z.array(z.string().max(16_384)).max(100_000),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

type State = z.infer<typeof StateSchema>;
type InternalWorkspace = z.infer<typeof InternalWorkspaceSchema>;
type InternalTab = z.infer<typeof InternalTabSchema>;
export type TerminalRuntimeWorkspaceState = InternalWorkspace;
export type TerminalRuntimeTabState = InternalTab;
export type TerminalSnapshot = z.infer<typeof SnapshotSchema>;

export class TerminalStateCorruptError extends Error {
  constructor() {
    super("Terminal workspace state is corrupt");
    this.name = "TerminalStateCorruptError";
  }
}

export interface TerminalWorkspaceStoreOptions {
  homePath: string;
  statePath?: string;
  now?: () => Date;
}

export class TerminalWorkspaceStore {
  private readonly statePath: string;
  private readonly snapshotDirectory: string;
  private readonly now: () => Date;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: TerminalWorkspaceStoreOptions) {
    this.statePath = options.statePath ?? join(options.homePath, "system", "terminal-workspaces.json");
    this.snapshotDirectory = join(dirname(this.statePath), "terminal-workspaces", "scrollback");
    this.now = options.now ?? (() => new Date());
  }

  async ensureWorkspace(input: { projectId?: string } = {}): Promise<TerminalWorkspace> {
    const projectId = input.projectId === undefined ? undefined : ProjectIdSchema.parse(input.projectId);
    return this.mutate((state) => {
      const existing = Object.values(state.workspaces).find((workspace) => projectId === undefined
        ? workspace.scope === "main"
        : workspace.scope === "project" && workspace.projectId === projectId);
      if (existing) return this.toPublicWorkspace(existing);

      const id = workspaceId();
      const now = this.now().toISOString();
      const workspace: InternalWorkspace = projectId === undefined
        ? {
            id,
            scope: "main",
            zellijSessionName: zellijWorkspaceName(),
            canonicalSize: DEFAULT_SIZE,
            status: "starting",
            revision: 0,
            createdAt: now,
            updatedAt: now,
            tabs: {},
          }
        : {
            id,
            scope: "project",
            projectId,
            zellijSessionName: zellijWorkspaceName(),
            canonicalSize: DEFAULT_SIZE,
            status: "starting",
            revision: 0,
            createdAt: now,
            updatedAt: now,
            tabs: {},
          };
      state.workspaces[id] = workspace;
      state.revision += 1;
      return this.toPublicWorkspace(workspace);
    });
  }

  async createTab(workspaceIdInput: string, input: {
    name: string;
    cwd: string;
    agent?: TerminalTab["agent"];
    git?: TerminalTab["git"];
  }): Promise<TerminalTab> {
    const targetWorkspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const name = SafeDisplayStringSchema.parse(input.name);
    const now = this.now().toISOString();
    return this.mutate((state) => {
      const workspace = state.workspaces[targetWorkspaceId];
      if (!workspace) throw new Error("Terminal workspace not found");
      const id = tabId();
      const tab = InternalTabSchema.parse({
        id,
        workspaceId: targetWorkspaceId,
        name,
        cwd: input.cwd,
        status: "starting",
        revision: 0,
        order: Object.keys(workspace.tabs).length,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.git ? { git: input.git } : {}),
        createdAt: now,
        updatedAt: now,
        zellijTabName: zellijTabName(),
        zellijTabId: null,
        zellijPaneId: null,
      });
      workspace.tabs[id] = tab;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicTab(tab);
    });
  }

  async createMigratedTab(workspaceIdInput: string, input: {
    migrationKey: string;
    name: string;
    cwd: string;
    createdAt?: string;
    uiState?: TerminalTab["uiState"];
    agent?: TerminalTab["agent"];
  }): Promise<TerminalTab> {
    const targetWorkspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const migrationKey = z.string().min(1).max(256).parse(input.migrationKey);
    const name = SafeDisplayStringSchema.parse(input.name);
    return this.mutate((state) => {
      const workspace = state.workspaces[targetWorkspaceId];
      if (!workspace) throw new Error("Terminal workspace not found");
      const existing = Object.values(workspace.tabs).find((tab) => tab.migrationKey === migrationKey);
      if (existing) return this.toPublicTab(existing);
      const id = tabId();
      const now = this.now().toISOString();
      const tab = InternalTabSchema.parse({
        id,
        workspaceId: targetWorkspaceId,
        name,
        cwd: input.cwd,
        status: "starting",
        revision: 0,
        order: Object.keys(workspace.tabs).length,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.uiState ? { uiState: input.uiState } : {}),
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        zellijTabName: zellijTabName(),
        zellijTabId: null,
        zellijPaneId: null,
        migrationKey,
      });
      workspace.tabs[id] = tab;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicTab(tab);
    });
  }

  async getTab(refInput: TerminalRef): Promise<TerminalTab | undefined> {
    const ref = TerminalRefSchema.parse(refInput);
    const state = await this.load();
    const tab = state.workspaces[ref.workspaceId]?.tabs[ref.tabId];
    return tab ? this.toPublicTab(tab) : undefined;
  }

  async listWorkspaces(): Promise<TerminalWorkspace[]> {
    const state = await this.load();
    return Object.values(state.workspaces)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((workspace) => this.toPublicWorkspace(workspace));
  }

  async getRuntimeWorkspace(workspaceIdInput: string): Promise<InternalWorkspace | undefined> {
    const targetWorkspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const workspace = (await this.load()).workspaces[targetWorkspaceId];
    return workspace ? structuredClone(workspace) : undefined;
  }

  async activateTab(refInput: TerminalRef, runtimeIds: { tabId: number; paneId: string }): Promise<TerminalTab> {
    const ref = TerminalRefSchema.parse(refInput);
    const zellijTabId = z.number().int().min(0).parse(runtimeIds.tabId);
    const zellijPaneId = z.string().regex(/^terminal_[0-9]+$/).parse(runtimeIds.paneId);
    const now = this.now().toISOString();
    return this.mutate((state) => {
      const workspace = state.workspaces[ref.workspaceId];
      const tab = workspace?.tabs[ref.tabId];
      if (!workspace || !tab) throw new Error("Terminal tab not found");
      tab.zellijTabId = zellijTabId;
      tab.zellijPaneId = zellijPaneId;
      tab.status = "running";
      tab.revision += 1;
      tab.updatedAt = now;
      workspace.status = "running";
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicTab(tab);
    });
  }

  async checkpointTab(refInput: TerminalRef, input: {
    ansi: string;
    viewport: string[];
    scrollback: string[];
  }): Promise<TerminalSnapshot> {
    const ref = TerminalRefSchema.parse(refInput);
    return this.mutate(async (state) => {
      const workspace = state.workspaces[ref.workspaceId];
      const tab = workspace?.tabs[ref.tabId];
      if (!workspace || !tab) throw new Error("Terminal tab not found");
      const previous = await this.readSnapshot(ref);
      const now = this.now().toISOString();
      tab.revision = Math.max(tab.revision, previous?.revision ?? 0) + 1;
      tab.updatedAt = now;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      const snapshot = SnapshotSchema.parse({
        schemaVersion: 1,
        terminalRef: ref,
        revision: tab.revision,
        seq: (previous?.seq ?? -1) + 1,
        ansi: input.ansi,
        viewport: input.viewport,
        scrollback: input.scrollback,
        updatedAt: now,
      });
      await this.persistSnapshot(snapshot);
      return snapshot;
    });
  }

  async importSnapshot(refInput: TerminalRef, input: {
    ansi: string;
    viewport: string[];
    scrollback: string[];
    seq: number;
  }): Promise<TerminalSnapshot> {
    const ref = TerminalRefSchema.parse(refInput);
    const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(input.seq);
    return this.mutate(async (state) => {
      const workspace = state.workspaces[ref.workspaceId];
      const tab = workspace?.tabs[ref.tabId];
      if (!workspace || !tab) throw new Error("Terminal tab not found");
      const previous = await this.readSnapshot(ref);
      if (
        previous?.seq === seq &&
        previous.ansi === input.ansi &&
        JSON.stringify(previous.viewport) === JSON.stringify(input.viewport) &&
        JSON.stringify(previous.scrollback) === JSON.stringify(input.scrollback)
      ) {
        return previous;
      }
      const now = this.now().toISOString();
      tab.revision = Math.max(tab.revision, previous?.revision ?? 0) + 1;
      tab.updatedAt = now;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      const snapshot = SnapshotSchema.parse({
        schemaVersion: 1,
        terminalRef: ref,
        revision: tab.revision,
        seq,
        ansi: input.ansi,
        viewport: input.viewport,
        scrollback: input.scrollback,
        updatedAt: now,
      });
      await this.persistSnapshot(snapshot);
      return snapshot;
    });
  }

  async renameTab(refInput: TerminalRef, input: { name: string; baseRevision: number }): Promise<TerminalTab> {
    const ref = TerminalRefSchema.parse(refInput);
    const name = SafeDisplayStringSchema.parse(input.name);
    const baseRevision = z.number().int().min(0).parse(input.baseRevision);
    const now = this.now().toISOString();
    return this.mutate((state) => {
      const workspace = state.workspaces[ref.workspaceId];
      const tab = workspace?.tabs[ref.tabId];
      if (!workspace || !tab) throw new Error("Terminal tab not found");
      if (tab.revision !== baseRevision) throw new Error("Terminal tab revision conflict");
      tab.name = name;
      tab.revision += 1;
      tab.updatedAt = now;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicTab(tab);
    });
  }

  async reorderTabs(workspaceIdInput: string, input: { tabIds: string[]; baseRevision: number }): Promise<TerminalWorkspace> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const tabIds = z.array(TerminalTabIdSchema).max(10_000).parse(input.tabIds);
    const baseRevision = z.number().int().min(0).parse(input.baseRevision);
    const now = this.now().toISOString();
    return this.mutate((state) => {
      const workspace = state.workspaces[workspaceId];
      if (!workspace) throw new Error("Terminal workspace not found");
      if (workspace.revision !== baseRevision) throw new Error("Terminal workspace revision conflict");
      const existingIds = Object.keys(workspace.tabs);
      if (new Set(tabIds).size !== tabIds.length || tabIds.length !== existingIds.length ||
          existingIds.some((id) => !tabIds.includes(id))) {
        throw new Error("Terminal tab order is incomplete");
      }
      tabIds.forEach((id, order) => { workspace.tabs[id]!.order = order; });
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicWorkspace(workspace);
    });
  }

  async updateTabUiState(refInput: TerminalRef, input: {
    placement?: "active" | "background";
    lastSeenSeq?: number | null;
    baseRevision: number;
  }): Promise<TerminalTab> {
    const ref = TerminalRefSchema.parse(refInput);
    const baseRevision = z.number().int().min(0).parse(input.baseRevision);
    const now = this.now().toISOString();
    return this.mutate((state) => {
      const workspace = state.workspaces[ref.workspaceId];
      const tab = workspace?.tabs[ref.tabId];
      if (!workspace || !tab) throw new Error("Terminal tab not found");
      if (tab.revision !== baseRevision) throw new Error("Terminal tab revision conflict");
      tab.uiState = {
        placement: input.placement ?? tab.uiState?.placement ?? "active",
        lastSeenSeq: input.lastSeenSeq === undefined ? tab.uiState?.lastSeenSeq ?? null : input.lastSeenSeq,
        ...(tab.uiState?.layoutName ? { layoutName: tab.uiState.layoutName } : {}),
        ...(tab.uiState?.legacyTabs ? { legacyTabs: tab.uiState.legacyTabs } : {}),
      };
      tab.revision += 1;
      tab.updatedAt = now;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicTab(tab);
    });
  }

  async markTabExited(refInput: TerminalRef, exitCode: number | null = null): Promise<TerminalTab> {
    const ref = TerminalRefSchema.parse(refInput);
    const now = this.now().toISOString();
    return this.mutate((state) => {
      const workspace = state.workspaces[ref.workspaceId];
      const tab = workspace?.tabs[ref.tabId];
      if (!workspace || !tab) throw new Error("Terminal tab not found");
      tab.status = "exited";
      tab.exitCode = exitCode;
      tab.revision += 1;
      tab.updatedAt = now;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicTab(tab);
    });
  }

  async updateCanonicalSize(workspaceIdInput: string, sizeInput: { cols: number; rows: number }): Promise<TerminalWorkspace> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const size = TerminalGridSizeSchema.parse(sizeInput);
    const now = this.now().toISOString();
    return this.mutate((state) => {
      const workspace = state.workspaces[workspaceId];
      if (!workspace) throw new Error("Terminal workspace not found");
      workspace.canonicalSize = size;
      workspace.revision += 1;
      workspace.updatedAt = now;
      state.revision += 1;
      return this.toPublicWorkspace(workspace);
    });
  }

  async removeWorkspace(workspaceIdInput: string): Promise<TerminalRuntimeWorkspaceState> {
    const workspaceId = TerminalWorkspaceIdSchema.parse(workspaceIdInput);
    const workspace = await this.mutate((state) => {
      const existing = state.workspaces[workspaceId];
      if (!existing) throw new Error("Terminal workspace not found");
      delete state.workspaces[workspaceId];
      state.revision += 1;
      return structuredClone(existing);
    });
    await Promise.all(Object.keys(workspace.tabs).map((id) => rm(this.snapshotPath(id), { force: true })));
    return workspace;
  }

  async readSnapshot(refInput: TerminalRef): Promise<TerminalSnapshot | undefined> {
    const ref = TerminalRefSchema.parse(refInput);
    const path = this.snapshotPath(ref.tabId);
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SNAPSHOT_BYTES) {
        throw new TerminalStateCorruptError();
      }
      const snapshot = SnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (snapshot.terminalRef.workspaceId !== ref.workspaceId) throw new TerminalStateCorruptError();
      return snapshot;
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof TerminalStateCorruptError) throw error;
      throw new TerminalStateCorruptError();
    }
  }

  private async mutate<T>(operation: (state: State) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writes = this.writes.then(async () => {
      try {
        const state = await this.load();
        const value = await operation(state);
        await this.persist(state);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private async load(): Promise<State> {
    try {
      const entry = await lstat(this.statePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_STATE_BYTES) {
        throw new TerminalStateCorruptError();
      }
      return StateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 2, revision: 0, workspaces: {} };
      if (error instanceof TerminalStateCorruptError) throw error;
      throw new TerminalStateCorruptError();
    }
  }

  private async persist(state: State): Promise<void> {
    const parsed = StateSchema.parse(state);
    await writeTextAtomic(this.statePath, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  private async persistSnapshot(snapshot: TerminalSnapshot): Promise<void> {
    const content = `${JSON.stringify(SnapshotSchema.parse(snapshot))}\n`;
    if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new Error("Terminal snapshot capacity reached");
    const target = this.snapshotPath(snapshot.terminalRef.tabId);
    await writeTextAtomic(target, content);
  }

  private snapshotPath(tabIdInput: string): string {
    return join(this.snapshotDirectory, `${TerminalTabIdSchema.parse(tabIdInput)}.json`);
  }

  private toPublicWorkspace(workspace: InternalWorkspace): TerminalWorkspace {
    const tabs = Object.values(workspace.tabs)
      .sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt))
      .map((tab) => this.toPublicTab(tab));
    const common = {
      id: workspace.id,
      canonicalSize: workspace.canonicalSize,
      status: workspace.status,
      revision: workspace.revision,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      tabs,
    };
    return TerminalWorkspaceSchema.parse(workspace.scope === "main"
      ? { ...common, scope: "main" }
      : { ...common, scope: "project", projectId: workspace.projectId });
  }

  private toPublicTab(tab: InternalTab): TerminalTab {
    const {
      zellijTabName: _tabName,
      zellijTabId: _tabId,
      zellijPaneId: _paneId,
      migrationKey: _migrationKey,
      ...publicTab
    } = tab;
    return TerminalTabSchema.parse(publicTab);
  }
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    const directoryHandle = await open(dirname(path), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error(
        "terminal workspace temporary-file cleanup failed",
        cleanupError instanceof Error ? cleanupError.name : "unknown_error",
      );
    }
    throw error;
  }
}

function workspaceId(): `tws_${string}` {
  return `tws_${randomBytes(16).toString("hex")}`;
}

function tabId(): `tt_${string}` {
  return `tt_${randomBytes(16).toString("hex")}`;
}

function zellijWorkspaceName(): string {
  return `matrix-w-${randomBytes(16).toString("hex")}`;
}

function zellijTabName(): string {
  return `matrix-tab-${randomBytes(16).toString("hex")}`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
