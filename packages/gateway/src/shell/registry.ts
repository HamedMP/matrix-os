import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { shellError } from "./errors.js";
import { resolveShellCwd, validateLayoutName, validateSessionName } from "./names.js";
import type { ScrollbackActivity, ScrollbackStore } from "./scrollback-store.js";

const ShellPlacementSchema = z.enum(["active", "background"]);
const ShellVisualStatusSchema = z.enum(["running", "finished", "idle", "waiting"]);
const SHELL_RUNNING_FALLBACK_WINDOW_MS = 12_000;

export interface ShellRegistryAdapter {
  listSessions(): Promise<string[]>;
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
  visualStatus: ShellVisualStatusSchema.optional(),
});

const RegistryFileSchema = z.object({
  sessions: z.record(z.string(), ShellSessionSchema).default({}),
  order: z.array(z.string()).optional(),
});

type PersistedShellSession = z.infer<typeof ShellSessionSchema>;
type RegistryFile = z.infer<typeof RegistryFileSchema>;
export type ShellPlacement = z.infer<typeof ShellPlacementSchema>;
export type ShellVisualStatus = z.infer<typeof ShellVisualStatusSchema>;
export interface ShellSession extends PersistedShellSession {
  latestSeq: number | null;
  unread: boolean;
  visualStatus: ShellVisualStatus;
  attachCommand: string;
}

export interface ShellSessionUiStatePatch {
  placement?: ShellPlacement;
  lastSeenSeq?: number | null;
  visualStatus?: ShellVisualStatus;
}

export interface ShellRegistryOptions {
  homePath: string;
  adapter: ShellRegistryAdapter;
  maxSessions?: number;
  persistPath?: string;
  scrollbackStore?: ScrollbackStore;
}

export class ShellRegistry {
  private readonly persistPath: string;
  private readonly maxSessions: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ShellRegistryOptions) {
    this.persistPath =
      options.persistPath ?? join(options.homePath, "system", "shell-sessions.json");
    this.maxSessions = options.maxSessions ?? 20;
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

      return this.decorateSessions(this.orderActiveSessions(file, activeSessions));
    });
  }

  async get(name: string): Promise<ShellSession> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      const live = await this.options.adapter.listSessions();
      if (!live.includes(safeName)) {
        throw shellError("session_not_found", "Session not found", 404);
      }
      const now = new Date().toISOString();
      const existing = file.sessions[safeName];
      const session: PersistedShellSession = {
        ...(existing ?? this.adoptSession(safeName, now)),
        status: "active" as const,
        updatedAt: existing?.status === "active" ? existing.updatedAt : now,
      };
      if (!existing || existing.status !== "active") {
        file.sessions[safeName] = session;
        await this.write(file);
      }
      return this.decorateSession(session);
    });
  }

  async create(input: {
    name: string;
    cwd?: string;
    layout?: string;
    cmd?: string;
  }): Promise<ShellSession> {
    return this.withMutationLock(async () => {
      const name = validateSessionName(input.name);
      const cwd = input.cwd ? await resolveShellCwd(input.cwd, this.options.homePath) : undefined;
      const layoutName = input.layout ? validateLayoutName(input.layout) : undefined;
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
        };
        file.sessions[name] = session;
        await this.write(file);
        return this.decorateSession(session);
      }
      if (changed) {
        await this.write(file);
      }
      if (live.size >= this.maxSessions) {
        throw shellError("session_limit", "Session limit reached", 507);
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

      return this.decorateSession(session);
    });
  }

  async updateUiState(name: string, patch: ShellSessionUiStatePatch): Promise<ShellSession> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      const now = new Date().toISOString();
      let existing = file.sessions[safeName];
      if (!existing) {
        const live = new Set(await this.options.adapter.listSessions());
        if (!live.has(safeName)) {
          throw shellError("session_not_found", "Session not found", 404);
        }
        existing = this.adoptSession(safeName, now);
      }
      const next: PersistedShellSession = {
        ...existing,
        updatedAt: now,
        ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
        ...(patch.lastSeenSeq !== undefined ? { lastSeenSeq: patch.lastSeenSeq } : {}),
        ...(patch.visualStatus !== undefined ? { visualStatus: patch.visualStatus } : {}),
      };
      file.sessions[safeName] = next;
      await this.write(file);
      return this.decorateSession(next);
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
      const live = new Set(await this.options.adapter.listSessions());
      if (!live.has(safeName)) {
        throw shellError("session_not_found", "Session not found", 404);
      }
      if (safeName === safeNextName) {
        const now = new Date().toISOString();
        const session = {
          ...(file.sessions[safeName] ?? this.adoptSession(safeName, now)),
          status: "active" as const,
        };
        file.sessions[safeName] = session;
        await this.write(file);
        return this.decorateSession(session);
      }
      if (live.has(safeNextName) || file.sessions[safeNextName]) {
        throw shellError("session_exists", "Session already exists", 409);
      }

      const now = new Date().toISOString();
      const existing = file.sessions[safeName] ?? this.adoptSession(safeName, now);
      const next: PersistedShellSession = {
        ...existing,
        name: safeNextName,
        status: "active",
        updatedAt: now,
      };
      delete file.sessions[safeName];
      file.sessions[safeNextName] = next;
      if (file.order) {
        file.order = file.order.map((entry) => entry === safeName ? safeNextName : entry);
      }

      await this.options.adapter.renameSession(safeName, safeNextName);
      let scrollbackRenamed = false;
      try {
        await this.options.scrollbackStore?.rename(safeName, safeNextName);
        scrollbackRenamed = true;
        if (file.order) {
          const nextLive = new Set(live);
          nextLive.delete(safeName);
          nextLive.add(safeNextName);
          this.normalizeCustomOrder(file, Array.from(nextLive).map((liveName) => file.sessions[liveName] ?? this.adoptSession(liveName, now)));
        }
        await this.write(file);
      } catch (err: unknown) {
        await this.options.adapter.renameSession(safeNextName, safeName).catch((rollbackErr: unknown) => {
          console.warn(
            "[shell] failed to rollback renamed zellij session:",
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          );
        });
        if (scrollbackRenamed) {
          await this.options.scrollbackStore?.rename(safeNextName, safeName).catch((rollbackErr: unknown) => {
            console.warn(
              "[shell] failed to rollback renamed scrollback:",
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            );
          });
        }
        throw err;
      }

      return this.decorateSession(next);
    });
  }

  async delete(name: string, options: { force?: boolean } = {}): Promise<void> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      if (!file.sessions[safeName]) {
        if (!options.force) {
          throw shellError("session_not_found", "Session not found", 404);
        }
        const live = new Set(await this.options.adapter.listSessions());
        if (!live.has(safeName)) {
          throw shellError("session_not_found", "Session not found", 404);
        }
      }
      await this.options.adapter.deleteSession(safeName, options);
      delete file.sessions[safeName];
      if (file.order) {
        file.order = file.order.filter((entry) => entry !== safeName);
      }
      await this.cleanupScrollback(safeName);
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
      return this.decorateSessions(orderedSessions);
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

  private async decorateSession(session: PersistedShellSession): Promise<ShellSession> {
    const activity = await this.options.scrollbackStore?.latestActivity?.(session.name);
    const latestSeq = activity?.latestSeq ?? await this.options.scrollbackStore?.latestSeq(session.name) ?? null;
    const lastSeenSeq = session.lastSeenSeq ?? session.lastSeq ?? latestSeq;
    const unread = latestSeq !== null && lastSeenSeq !== null && latestSeq > lastSeenSeq;
    const visualStatus = this.deriveVisualStatus(session, unread, activity);
    return {
      ...session,
      placement: session.placement ?? "active",
      lastSeenSeq: lastSeenSeq ?? null,
      latestSeq,
      unread,
      visualStatus,
      attachCommand: `mos shell attach ${session.name}`,
    };
  }

  private deriveVisualStatus(
    session: PersistedShellSession,
    unread: boolean,
    activity?: ScrollbackActivity,
  ): ShellVisualStatus {
    if (session.visualStatus === "waiting") {
      return "waiting";
    }
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

  private async decorateSessions(sessions: PersistedShellSession[]): Promise<ShellSession[]> {
    const decorated: ShellSession[] = [];
    for (const session of sessions) {
      decorated.push(await this.decorateSession(session));
    }
    return decorated;
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

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function isRecentShellOutput(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return Date.now() - timestamp <= SHELL_RUNNING_FALLBACK_WINDOW_MS;
}
