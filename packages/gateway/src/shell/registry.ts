import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { shellError } from "./errors.js";
import { resolveShellCwd, validateLayoutName, validateSessionName } from "./names.js";
import type { ScrollbackStore } from "./scrollback-store.js";

const ShellPlacementSchema = z.enum(["active", "background"]);
const ShellVisualStatusSchema = z.enum(["running", "finished", "idle", "waiting"]);

export interface ShellRegistryAdapter {
  listSessions(): Promise<string[]>;
  createSession(options: { name: string; cwd?: string; layout?: string; cmd?: string }): Promise<void>;
  deleteSession(name: string, options?: { force?: boolean }): Promise<void>;
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
});

type PersistedShellSession = z.infer<typeof ShellSessionSchema>;
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
      const sessions: ShellSession[] = [];
      const now = new Date().toISOString();

      for (const name of live) {
        const existing = file.sessions[name];
        const session: PersistedShellSession = {
          ...(existing ?? this.adoptSession(name, now)),
          status: "active" as const,
          updatedAt: existing?.status === "active" ? existing.updatedAt : now,
        };
        sessions.push(await this.decorateSession(session));
        if (!existing || existing.status !== "active") {
          file.sessions[name] = session;
          changed = true;
        }
      }

      changed = await this.markMissingMetadataExited(file, new Set(live)) || changed;

      if (changed) {
        await this.write(file);
      }

      return sessions;
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
      const existing = file.sessions[safeName] ?? this.adoptSession(safeName, now);
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
      await this.cleanupScrollback(safeName);
      await this.write(file);
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
    const latestSeq = await this.options.scrollbackStore?.latestSeq(session.name) ?? null;
    const lastSeenSeq = session.lastSeenSeq ?? session.lastSeq ?? latestSeq;
    const unread = latestSeq !== null && lastSeenSeq !== null && latestSeq > lastSeenSeq;
    const visualStatus = session.visualStatus ?? (
      session.status === "active"
        ? "running"
        : unread
          ? "finished"
          : "idle"
    );
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

  private async markMissingMetadataExited(
    file: z.infer<typeof RegistryFileSchema>,
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

  private async read(): Promise<z.infer<typeof RegistryFileSchema>> {
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

  private async write(file: z.infer<typeof RegistryFileSchema>): Promise<void> {
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
