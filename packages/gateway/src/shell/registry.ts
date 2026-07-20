import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import {
  UNAVAILABLE_FOCUSED_PANE_RUNTIME,
  type FocusedPaneRuntimeObservation,
} from "./focused-pane-runtime.js";
import {
  AgentKindSchema,
  AgentSessionStateStore,
  deriveAgentVisualStatus,
  type AgentKind,
  type AgentSessionSnapshot,
} from "./agent-session-state.js";
import { shellError } from "./errors.js";
import { resolveShellCwd, SESSION_NAME_PATTERN, validateLayoutName, validateSessionName } from "./names.js";
import type { ScrollbackActivity, ScrollbackStore } from "./scrollback-store.js";
import {
  TerminalGitContextResolver,
  type TerminalGitContext,
  type TerminalGitContextInput,
} from "./terminal-git-context.js";

const ShellPlacementSchema = z.enum(["active", "background"]);
const ShellVisualStatusSchema = z.enum(["running", "finished", "idle", "waiting"]);
const ShellSessionReferenceSourceSchema = z.enum(["pane", "workspace", "legacy"]);
const ShellSessionReferenceSchema = z.object({
  id: z.string().min(1).max(128),
  source: ShellSessionReferenceSourceSchema,
  sessionName: z.string().regex(SESSION_NAME_PATTERN),
});
const SHELL_RUNNING_FALLBACK_WINDOW_MS = 12_000;
const MAX_CONCURRENT_SESSION_DECORATIONS = 8;

export interface ShellRegistryAdapter {
  listSessions(): Promise<string[]>;
  focusedPaneRuntime?(name: string): Promise<FocusedPaneRuntimeObservation>;
  createSession(options: { name: string; cwd?: string; layout?: string; cmd?: string }): Promise<void>;
  deleteSession(name: string, options?: { force?: boolean }): Promise<void>;
  renameSession?(name: string, nextName: string): Promise<void>;
}

const ShellSessionSchema = z.object({
  name: z.string(),
  status: z.enum(["active", "exited"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  layoutName: z.string().optional(),
  tabs: z.array(z.object({
    idx: z.number(),
    name: z.string().optional(),
    focused: z.boolean().optional(),
    createdAt: z.string().optional(),
  })).default([]),
  attachedClients: z.number().int().nonnegative().default(0),
  lastSeq: z.number().int().nonnegative().optional(),
  placement: ShellPlacementSchema.default("active"),
  lastSeenSeq: z.number().int().nonnegative().nullable().default(null),
  // "session" for sessions created after reaper support shipped; absent for
  // pre-upgrade sessions, which are exempt from TTL reaping (spec 107 FR-018).
  kind: z.string().optional(),
  // Canonical terminal size negotiated across hard clients (spec 107 FR-006).
  canonicalSize: z.object({
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(200),
  }).optional(),
  visualStatus: ShellVisualStatusSchema.optional(),
  visualStatusUpdatedAt: z.string().optional(),
  agent: AgentKindSchema.optional(),
  cwd: z.string().max(4096).optional(),
});

const RegistryFileSchema = z.object({
  sessions: z.record(z.string(), ShellSessionSchema).default({}),
  order: z.array(z.string()).optional(),
  aliases: z.record(z.string(), z.string()).catch({}).optional(),
  references: z.array(ShellSessionReferenceSchema).catch([]).optional(),
});

type PersistedShellSession = z.infer<typeof ShellSessionSchema>;
type RegistryFile = z.infer<typeof RegistryFileSchema>;
type ShellSessionReference = z.infer<typeof ShellSessionReferenceSchema>;
export type ShellPlacement = z.infer<typeof ShellPlacementSchema>;
export type ShellVisualStatus = z.infer<typeof ShellVisualStatusSchema>;
export type ShellSessionAliasSource = z.infer<typeof ShellSessionReferenceSourceSchema>;
export interface ShellSessionAlias {
  name: string;
  target: string;
  source: ShellSessionAliasSource;
}
export type ShellSession = Omit<PersistedShellSession, "cwd"> & {
  canonicalName: string;
  latestSeq: number | null;
  unread: boolean;
  visualStatus: ShellVisualStatus;
  attachCommand: string;
  aliases: ShellSessionAlias[];
  references: ShellSessionReference[];
  recoverable: boolean;
  recoveryReason?: "missing_runtime_session";
  /** Agent currently observed in the focused pane, not the persisted launch provider. */
  agent?: AgentKind;
  subtitle?: string;
  lastAction?: string;
  agentUpdatedAt?: string;
  model?: string;
  strength?: string;
  project?: string;
  repository?: string;
  branch?: string;
  pullRequest?: TerminalGitContext["pullRequest"];
};

export interface ShellSessionUiStatePatch {
  placement?: ShellPlacement;
  lastSeenSeq?: number | null;
  /** @deprecated Accepted for one compatibility release and intentionally ignored. */
  visualStatus?: ShellVisualStatus;
}

export interface ShellNameScopedStore {
  rename(fromName: string, toName: string): Promise<void>;
}

export interface ShellAgentStateStore extends ShellNameScopedStore {
  get(name: string): Promise<AgentSessionSnapshot | null>;
  delete(name: string): Promise<void>;
}

export interface ShellRegistryOptions {
  homePath: string;
  adapter: ShellRegistryAdapter;
  persistPath?: string;
  scrollbackStore?: ScrollbackStore;
  preferencesStore?: ShellNameScopedStore;
  agentStateStore?: ShellAgentStateStore;
  gitContextResolver?: { resolve(input: TerminalGitContextInput): Promise<TerminalGitContext | null> };
}

export class ShellRegistry {
  private readonly persistPath: string;
  private readonly agentStateStore: ShellAgentStateStore;
  private readonly gitContextResolver: { resolve(input: TerminalGitContextInput): Promise<TerminalGitContext | null> };
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ShellRegistryOptions) {
    this.persistPath =
      options.persistPath ?? join(options.homePath, "system", "shell-sessions.json");
    this.agentStateStore = options.agentStateStore ?? new AgentSessionStateStore({ homePath: options.homePath });
    this.gitContextResolver = options.gitContextResolver ?? new TerminalGitContextResolver({ homePath: options.homePath });
  }

  async list(): Promise<ShellSession[]> {
    return this.withMutationLock(async () => {
      const file = await this.read();
      const live = await this.options.adapter.listSessions();
      let changed = false;
      const now = new Date().toISOString();
      const activeSessions: PersistedShellSession[] = [];

      for (const name of live) {
        const existing = file.sessions[name];
        const session: PersistedShellSession = {
          ...(existing ?? this.adoptSession(name, now)),
          status: "active" as const,
          updatedAt: existing?.status === "active" ? existing.updatedAt : now,
        };
        activeSessions.push(session);
        if (!existing || existing.status !== "active") {
          file.sessions[name] = session;
          changed = true;
        }
      }

      changed = await this.markMissingMetadataExited(file, new Set(live)) || changed;
      changed = this.normalizeCustomOrder(file, activeSessions) || changed;

      if (changed) {
        await this.write(file);
      }

      return this.decorateSessions(this.withRecoverableReferences(file, live, this.orderActiveSessions(file, activeSessions)), file);
    });
  }

  async get(name: string): Promise<ShellSession> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      const targetName = this.resolveSessionName(file, safeName);
      const live = await this.options.adapter.listSessions();
      if (!live.includes(targetName)) {
        throw shellError("session_not_found", "Session not found", 404);
      }
      const now = new Date().toISOString();
      const existing = file.sessions[targetName];
      const session: PersistedShellSession = {
        ...(existing ?? this.adoptSession(targetName, now)),
        status: "active" as const,
        updatedAt: existing?.status === "active" ? existing.updatedAt : now,
      };
      if (!existing || existing.status !== "active") {
        file.sessions[targetName] = session;
        await this.write(file);
      }
      return this.decorateSession(session, file);
    });
  }

  async create(input: {
    name: string;
    cwd?: string;
    layout?: string;
    cmd?: string;
    agent?: AgentKind;
  }): Promise<ShellSession> {
    return this.withMutationLock(async () => {
      const name = validateSessionName(input.name);
      const cwd = input.cwd ? await resolveShellCwd(input.cwd, this.options.homePath) : undefined;
      const layoutName = input.layout ? validateLayoutName(input.layout) : undefined;
      const agent = input.agent ?? inferAgentFromCommand(input.cmd);
      const file = await this.read();
      const live = new Set(await this.options.adapter.listSessions());

      let changed = await this.markMissingMetadataExited(file, live);

      if (live.has(name)) {
        const now = new Date().toISOString();
        const session: PersistedShellSession = {
          ...(file.sessions[name] ?? this.adoptSession(name, now)),
          status: "active",
          updatedAt: now,
          ...(layoutName ? { layoutName } : {}),
          ...(agent ? { agent } : {}),
          ...(cwd ? { cwd } : {}),
        };
        file.sessions[name] = session;
        await this.write(file);
        return this.decorateSession(session, file);
      }
      if (changed) {
        await this.write(file);
      }
      await this.options.adapter.createSession({ name, cwd, layout: layoutName, cmd: input.cmd });
      const now = new Date().toISOString();
      const session: PersistedShellSession = {
        name,
        status: "active",
        createdAt: now,
        updatedAt: now,
        layoutName,
        tabs: [],
        attachedClients: 0,
        placement: "active",
        lastSeenSeq: null,
        kind: "session",
        ...(agent ? { agent } : {}),
        ...(cwd ? { cwd } : {}),
      };
      file.sessions[name] = session;
      if (file.order) {
        file.order = this.orderedNamesFromSessions(this.orderActiveSessions(file, [
          ...Array.from(live)
            .filter((liveName) => liveName !== name)
            .map((liveName) => file.sessions[liveName] ?? this.adoptSession(liveName, now)),
          session,
        ]));
      }

      try {
        await this.write(file);
      } catch (err) {
        await this.options.adapter.deleteSession(name, { force: true }).catch((rollbackErr: unknown) => {
          console.warn(
            "[shell] failed to rollback orphan zellij session:",
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          );
        });
        throw err;
      }

      return this.decorateSession(session, file);
    });
  }

  async updateUiState(name: string, patch: ShellSessionUiStatePatch): Promise<ShellSession> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      const now = new Date().toISOString();
      const targetName = this.resolveSessionName(file, safeName);
      let existing = file.sessions[targetName];
      if (!existing) {
        const live = new Set(await this.options.adapter.listSessions());
        if (!live.has(targetName)) {
          throw shellError("session_not_found", "Session not found", 404);
        }
        existing = this.adoptSession(targetName, now);
      }
      const next: PersistedShellSession = {
        ...existing,
        updatedAt: now,
        ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
        ...(patch.lastSeenSeq !== undefined ? { lastSeenSeq: patch.lastSeenSeq } : {}),
      };
      delete next.visualStatus;
      delete next.visualStatusUpdatedAt;
      file.sessions[targetName] = next;
      await this.write(file);
      return this.decorateSession(next, file);
    });
  }

  async rename(name: string, nextName: string): Promise<ShellSession> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const safeNextName = validateSessionName(nextName);
      if (!this.options.adapter.renameSession) {
        throw shellError("session_rename_unavailable", "Request failed", 503);
      }

      const file = await this.read();
      const targetName = this.resolveSessionName(file, safeName);
      const live = new Set(await this.options.adapter.listSessions());
      if (!live.has(targetName)) {
        throw shellError("session_not_found", "Session not found", 404);
      }
      if (targetName === safeNextName) {
        const now = new Date().toISOString();
        const session = {
          ...(file.sessions[targetName] ?? this.adoptSession(targetName, now)),
          status: "active" as const,
        };
        file.sessions[targetName] = session;
        await this.write(file);
        return this.decorateSession(session, file);
      }
      const existingAliasTarget = file.aliases?.[safeNextName];
      if (existingAliasTarget !== undefined && existingAliasTarget !== targetName) {
        throw shellError("session_exists", "Session already exists", 409);
      }
      if (live.has(safeNextName) || file.sessions[safeNextName]) {
        throw shellError("session_exists", "Session already exists", 409);
      }

      const now = new Date().toISOString();
      const existing = file.sessions[targetName] ?? this.adoptSession(targetName, now);
      const next: PersistedShellSession = {
        ...existing,
        name: safeNextName,
        status: "active",
        updatedAt: now,
      };
      delete file.sessions[targetName];
      file.sessions[safeNextName] = next;
      if (file.order) {
        file.order = file.order.map((entry) => entry === targetName ? safeNextName : entry);
      }
      if (file.aliases?.[safeNextName] === targetName) {
        delete file.aliases[safeNextName];
        if (Object.keys(file.aliases).length === 0) {
          delete file.aliases;
        }
      }
      this.retargetAliasesAndReferences(file, targetName, safeNextName);

      await this.options.adapter.renameSession(targetName, safeNextName);
      let scrollbackRenamed = false;
      let preferencesRenamed = false;
      let agentStateRenamed = false;
      try {
        await this.options.scrollbackStore?.rename(targetName, safeNextName);
        scrollbackRenamed = true;
        await this.options.preferencesStore?.rename(targetName, safeNextName);
        preferencesRenamed = true;
        try {
          await this.agentStateStore.rename(targetName, safeNextName);
          agentStateRenamed = true;
        } catch (err: unknown) {
          console.warn(
            "[shell] failed to rename agent session state:",
            err instanceof Error ? err.message : String(err),
          );
        }
        if (file.order) {
          const nextLive = new Set(live);
          nextLive.delete(targetName);
          nextLive.add(safeNextName);
          void this.normalizeCustomOrder(file, Array.from(nextLive).map((liveName) => file.sessions[liveName] ?? this.adoptSession(liveName, now)));
        }
        await this.write(file);
      } catch (err: unknown) {
        await this.options.adapter.renameSession(safeNextName, targetName).catch((rollbackErr: unknown) => {
          console.warn(
            "[shell] failed to rollback renamed zellij session:",
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          );
        });
        if (scrollbackRenamed) {
          await this.options.scrollbackStore?.rename(safeNextName, targetName).catch((rollbackErr: unknown) => {
            console.warn(
              "[shell] failed to rollback renamed scrollback:",
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            );
          });
        }
        if (preferencesRenamed) {
          await this.options.preferencesStore?.rename(safeNextName, targetName).catch((rollbackErr: unknown) => {
            console.warn(
              "[shell] failed to rollback renamed preferences:",
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            );
          });
        }
        if (agentStateRenamed) {
          await this.agentStateStore.rename(safeNextName, targetName).catch((rollbackErr: unknown) => {
            console.warn(
              "[shell] failed to rollback renamed agent state:",
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            );
          });
        }
        throw err;
      }

      return this.decorateSession(next, file);
    });
  }

  async updateCanonicalSize(name: string, size: { cols: number; rows: number }): Promise<void> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      const targetName = this.resolveSessionName(file, safeName);
      const session = file.sessions[targetName];
      if (!session) {
        return;
      }
      file.sessions[targetName] = { ...session, canonicalSize: size, updatedAt: new Date().toISOString() };
      await this.write(file);
    });
  }

  async delete(name: string, options: { force?: boolean } = {}): Promise<void> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      const targetName = this.resolveSessionName(file, safeName);
      if (!file.sessions[targetName]) {
        if (!options.force) {
          throw shellError("session_not_found", "Session not found", 404);
        }
        const live = new Set(await this.options.adapter.listSessions());
        if (!live.has(targetName)) {
          throw shellError("session_not_found", "Session not found", 404);
        }
      }
      await this.options.adapter.deleteSession(targetName, options);
      delete file.sessions[targetName];
      if (file.order) {
        file.order = file.order.filter((entry) => entry !== targetName);
      }
      this.removeReferencesForTarget(file, targetName);
      this.removeAliasesForTarget(file, targetName);
      await this.cleanupScrollback(targetName);
      await this.cleanupAgentState(targetName);
      await this.write(file);
    });
  }

  async reorder(order: string[]): Promise<ShellSession[]> {
    return this.withMutationLock(async () => {
      const requestedOrder = Array.from(new Set(order.map((name) => validateSessionName(name))));
      const file = await this.read();
      const live = await this.options.adapter.listSessions();
      const liveSet = new Set(live);
      const now = new Date().toISOString();
      const activeSessions: PersistedShellSession[] = [];

      for (const name of live) {
        const existing = file.sessions[name];
        const session: PersistedShellSession = {
          ...(existing ?? this.adoptSession(name, now)),
          status: "active",
          updatedAt: existing?.status === "active" ? existing.updatedAt : now,
        };
        activeSessions.push(session);
        if (!existing || existing.status !== "active") {
          file.sessions[name] = session;
        }
      }

      await this.markMissingMetadataExited(file, liveSet);
      const requestedLiveSessions = requestedOrder
        .filter((name) => liveSet.has(name))
        .map((name) => file.sessions[name])
        .filter((session): session is PersistedShellSession => session !== undefined);
      const requestedLiveNames = new Set(requestedLiveSessions.map((session) => session.name));
      const appendedSessions = this.defaultOrderSessions(
        activeSessions.filter((session) => !requestedLiveNames.has(session.name)),
        false,
      );
      const orderedSessions = [...requestedLiveSessions, ...appendedSessions];
      file.order = this.orderedNamesFromSessions(orderedSessions);

      await this.write(file);
      return this.decorateSessions(orderedSessions, file);
    });
  }

  private adoptSession(name: string, now: string): PersistedShellSession {
    return {
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
      tabs: [],
      attachedClients: 0,
      placement: "active",
      lastSeenSeq: null,
    };
  }

  private async decorateSession(session: PersistedShellSession, file?: RegistryFile): Promise<ShellSession> {
    const [activity, agentSnapshot, focusedPaneRuntime] = await Promise.all([
      this.options.scrollbackStore?.latestActivity?.(session.name),
      this.readAgentSnapshot(session.name),
      this.readFocusedPaneRuntime(session.name),
    ]);
    const latestSeq = activity?.latestSeq ?? await this.options.scrollbackStore?.latestSeq(session.name) ?? null;
    const lastSeenSeq = session.lastSeenSeq ?? session.lastSeq ?? latestSeq;
    const unread = latestSeq !== null && lastSeenSeq !== null && latestSeq > lastSeenSeq;
    const references = file ? this.referencesForTarget(file, session.name) : [];
    const recoverable = session.status === "exited" && references.length > 0;
    const gitContext = await this.readGitContext({
      sessionName: session.name,
      cwd: focusedPaneRuntime.cwd ?? session.cwd,
    });
    const observedAgent = focusedPaneRuntime.observed
      ? inferAgentFromCommand(focusedPaneRuntime.command ?? undefined)
      : undefined;
    const compatibleSnapshot = agentSnapshot?.phase !== "ended" && (
      focusedPaneRuntime.observed
        ? agentSnapshot?.agent === observedAgent
        : Boolean(agentSnapshot)
    ) ? agentSnapshot : null;
    const launchHintAgent = !focusedPaneRuntime.observed
      && !agentSnapshot
      && session.agent
      && isRecentShellTimestamp(session.updatedAt, SHELL_RUNNING_FALLBACK_WINDOW_MS)
      ? session.agent
      : undefined;
    const liveAgent = focusedPaneRuntime.observed
      ? observedAgent
      : compatibleSnapshot?.agent ?? launchHintAgent;
    const agentVisualStatus = liveAgent
      ? deriveAgentVisualStatus(compatibleSnapshot, unread) ?? "running"
      : null;
    const visualStatus = agentVisualStatus
      ?? this.deriveVisualStatus(session, unread, activity);
    const { cwd: _internalCwd, agent: _launchHint, ...publicSession } = session;
    return {
      ...publicSession,
      ...(liveAgent ? { agent: liveAgent } : {}),
      ...(compatibleSnapshot?.subtitle ? { subtitle: compatibleSnapshot.subtitle } : {}),
      ...(compatibleSnapshot?.lastAction ? { lastAction: compatibleSnapshot.lastAction } : {}),
      ...(compatibleSnapshot?.agentUpdatedAt ? { agentUpdatedAt: compatibleSnapshot.agentUpdatedAt } : {}),
      ...(compatibleSnapshot?.model ? { model: compatibleSnapshot.model } : {}),
      ...(compatibleSnapshot?.strength ? { strength: compatibleSnapshot.strength } : {}),
      ...(gitContext?.project ? { project: gitContext.project } : {}),
      ...(gitContext?.repository ? { repository: gitContext.repository } : {}),
      ...(gitContext?.branch ? { branch: gitContext.branch } : {}),
      ...(gitContext?.pullRequest ? { pullRequest: gitContext.pullRequest } : {}),
      placement: session.placement ?? "active",
      lastSeenSeq: lastSeenSeq ?? null,
      latestSeq,
      unread,
      visualStatus,
      attachCommand: `mos shell attach ${session.name}`,
      canonicalName: session.name,
      aliases: file ? this.aliasesForTarget(file, session.name) : [],
      references,
      recoverable,
      ...(recoverable ? { recoveryReason: "missing_runtime_session" as const } : {}),
    };
  }

  private deriveVisualStatus(
    session: PersistedShellSession,
    unread: boolean,
    activity?: ScrollbackActivity,
  ): ShellVisualStatus {
    if (session.status !== "active") {
      return unread ? "finished" : "idle";
    }
    if (activity?.commandRunning === true) {
      return "running";
    }
    if (activity?.commandRunning === false) {
      return unread ? "finished" : "idle";
    }
    if (activity?.latestOutputAt && isRecentShellOutput(activity.latestOutputAt)) {
      return "running";
    }
    return unread ? "finished" : "idle";
  }

  private async markMissingMetadataExited(
    file: RegistryFile,
    live: Set<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = new Date().toISOString();
    for (const [name, session] of Object.entries(file.sessions)) {
      if (live.has(name) || session.status === "exited") {
        continue;
      }
      file.sessions[name] = { ...session, status: "exited", updatedAt: now };
      changed = true;
    }
    return changed;
  }

  private defaultOrderSessions(sessions: PersistedShellSession[], mainFirst = true): PersistedShellSession[] {
    return [...sessions].sort((left, right) => {
      if (mainFirst) {
        if (left.name === "main" && right.name !== "main") return -1;
        if (right.name === "main" && left.name !== "main") return 1;
      }
      const created = left.createdAt.localeCompare(right.createdAt);
      return created === 0 ? left.name.localeCompare(right.name) : created;
    });
  }

  private orderedNamesFromSessions(sessions: PersistedShellSession[]): string[] {
    return sessions.map((session) => session.name);
  }

  private orderActiveSessions(file: RegistryFile, sessions: PersistedShellSession[]): PersistedShellSession[] {
    if (!file.order) {
      return this.defaultOrderSessions(sessions);
    }
    const byName = new Map(sessions.map((session) => [session.name, session]));
    const ordered: PersistedShellSession[] = [];
    const seen = new Set<string>();
    for (const name of file.order) {
      const session = byName.get(name);
      if (!session || seen.has(name)) {
        continue;
      }
      ordered.push(session);
      seen.add(name);
    }
    const appended = this.defaultOrderSessions(sessions.filter((session) => !seen.has(session.name)), false);
    return [...ordered, ...appended];
  }

  private normalizeCustomOrder(file: RegistryFile, activeSessions: PersistedShellSession[]): boolean {
    if (!file.order) {
      return false;
    }
    const nextOrder = this.orderedNamesFromSessions(this.orderActiveSessions(file, activeSessions));
    const changed = file.order.length !== nextOrder.length || file.order.some((name, index) => name !== nextOrder[index]);
    if (changed) {
      file.order = nextOrder;
    }
    return changed;
  }

  private async decorateSessions(sessions: PersistedShellSession[], file?: RegistryFile): Promise<ShellSession[]> {
    const decorated: ShellSession[] = new Array(sessions.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_SESSION_DECORATIONS, sessions.length) },
      async () => {
        while (nextIndex < sessions.length) {
          const index = nextIndex;
          nextIndex += 1;
          decorated[index] = await this.decorateSession(sessions[index], file);
        }
      },
    );
    await Promise.all(workers);
    return decorated;
  }

  private withRecoverableReferences(
    file: RegistryFile,
    live: string[],
    activeSessions: PersistedShellSession[],
  ): PersistedShellSession[] {
    const liveSet = new Set(live);
    const activeNames = new Set(activeSessions.map((session) => session.name));
    const result = [...activeSessions];
    const now = new Date().toISOString();

    for (const reference of file.references ?? []) {
      const targetName = this.resolveSessionName(file, reference.sessionName);
      if (liveSet.has(targetName) || activeNames.has(targetName)) {
        continue;
      }
      if (activeNames.has(reference.sessionName)) {
        continue;
      }
      const existing = file.sessions[targetName] ?? file.sessions[reference.sessionName];
      result.push({
        ...(existing ?? this.adoptSession(targetName, now)),
        name: targetName,
        status: "exited",
        updatedAt: existing?.updatedAt ?? now,
      });
      activeNames.add(targetName);
      activeNames.add(reference.sessionName);
    }

    return result;
  }

  private resolveSessionName(file: RegistryFile, name: string): string {
    const target = file.aliases?.[name];
    return target && isSessionName(target) ? target : name;
  }

  private aliasesForTarget(file: RegistryFile, target: string): ShellSessionAlias[] {
    return Object.entries(file.aliases ?? {})
      .filter(([name, aliasTarget]) => isSessionName(name) && aliasTarget === target)
      .map(([name, aliasTarget]) => ({
        name,
        target: aliasTarget,
        source: inferAliasSource(name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private referencesForTarget(file: RegistryFile, target: string): ShellSessionReference[] {
    return (file.references ?? [])
      .filter((reference) => this.resolveSessionName(file, reference.sessionName) === target)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private removeAliasesForTarget(file: RegistryFile, target: string): void {
    if (!file.aliases) {
      return;
    }
    for (const [alias, aliasTarget] of Object.entries(file.aliases)) {
      if (alias === target || aliasTarget === target) {
        delete file.aliases[alias];
      }
    }
    if (Object.keys(file.aliases).length === 0) {
      delete file.aliases;
    }
  }

  private removeReferencesForTarget(file: RegistryFile, target: string): void {
    if (!file.references) {
      return;
    }
    file.references = file.references.filter((reference) => (
      reference.sessionName !== target && this.resolveSessionName(file, reference.sessionName) !== target
    ));
    if (file.references.length === 0) {
      delete file.references;
    }
  }

  private retargetAliasesAndReferences(file: RegistryFile, fromName: string, toName: string): void {
    if (file.aliases) {
      for (const [alias, target] of Object.entries(file.aliases)) {
        if (target === fromName) {
          file.aliases[alias] = toName;
        }
      }
    }
    if (file.references) {
      file.references = file.references.map((reference) => (
        reference.sessionName === fromName ? { ...reference, sessionName: toName } : reference
      ));
    }
  }

  private async read(): Promise<RegistryFile> {
    try {
      const raw = await readFile(this.persistPath, "utf-8");
      return RegistryFileSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { sessions: {} };
      }
      throw err;
    }
  }

  private async write(file: RegistryFile): Promise<void> {
    await writeUtf8FileAtomic(this.persistPath, JSON.stringify(file, null, 2));
  }

  private async cleanupScrollback(name: string): Promise<void> {
    try {
      await this.options.scrollbackStore?.cleanup(name);
    } catch (err: unknown) {
      console.warn(
        "[shell] failed to clean scrollback:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async cleanupAgentState(name: string): Promise<void> {
    try {
      await this.agentStateStore.delete(name);
    } catch (err: unknown) {
      console.warn(
        "[shell] failed to clean agent session state:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async readAgentSnapshot(name: string): Promise<AgentSessionSnapshot | null> {
    try {
      return await this.agentStateStore.get(name);
    } catch (err: unknown) {
      console.warn(
        "[shell] agent session state unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async readFocusedPaneRuntime(name: string): Promise<FocusedPaneRuntimeObservation> {
    if (!this.options.adapter.focusedPaneRuntime) return UNAVAILABLE_FOCUSED_PANE_RUNTIME;
    try {
      const runtime = await this.options.adapter.focusedPaneRuntime(name);
      if (!runtime.cwd) return runtime;
      try {
        return { ...runtime, cwd: await resolveShellCwd(runtime.cwd, this.options.homePath) };
      } catch (err: unknown) {
        console.warn(
          "[shell] focused pane cwd unavailable:",
          err instanceof Error ? err.message : String(err),
        );
        return { ...runtime, cwd: null };
      }
    } catch (err: unknown) {
      console.warn(
        "[shell] focused pane runtime unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return UNAVAILABLE_FOCUSED_PANE_RUNTIME;
    }
  }

  private async readGitContext(input: TerminalGitContextInput): Promise<TerminalGitContext | null> {
    try {
      return await this.gitContextResolver.resolve(input);
    } catch (err: unknown) {
      console.warn(
        "[shell] terminal Git context unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function inferAgentFromCommand(command: string | undefined): AgentKind | undefined {
  if (!command) return undefined;
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => (
    token.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2")
  )) ?? [];
  let index = 0;
  if (tokens[index]?.split("/").pop() === "env") {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      if (token === "--") {
        index += 1;
        break;
      }
      if (token === "-i" || token === "--ignore-environment" || token === "-0" || token === "--null") {
        index += 1;
        continue;
      }
      if (/^(?:--unset|--chdir)=/.test(token) || /^-[uC].+/.test(token)) {
        index += 1;
        continue;
      }
      if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
        if (tokens[index + 1] === undefined) return undefined;
        index += 2;
        continue;
      }
      if (token.startsWith("-")) return undefined;
      break;
    }
  }
  const executable = tokens[index]?.split("/").pop();
  const parsed = AgentKindSchema.safeParse(executable);
  return parsed.success ? parsed.data : undefined;
}

function inferAliasSource(name: string): ShellSessionAliasSource {
  return name.startsWith("matrix-sess_") ? "legacy" : "workspace";
}

function isSessionName(value: string): boolean {
  return SESSION_NAME_PATTERN.test(value);
}

function isRecentShellOutput(value: string): boolean {
  return isRecentShellTimestamp(value, SHELL_RUNNING_FALLBACK_WINDOW_MS);
}

function isRecentShellTimestamp(value: string, windowMs: number): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return Date.now() - timestamp <= windowMs;
}
