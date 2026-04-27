import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { shellError } from "./errors.js";
import { resolveShellCwd, validateLayoutName, validateSessionName } from "./names.js";
import type { ScrollbackStore } from "./scrollback-store.js";

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
});

const RegistryFileSchema = z.object({
  sessions: z.record(z.string(), ShellSessionSchema).default({}),
});

export type ShellSession = z.infer<typeof ShellSessionSchema>;

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
      const live = new Set(await this.options.adapter.listSessions());
      let changed = false;

      for (const name of Object.keys(file.sessions)) {
        if (!live.has(name)) {
          delete file.sessions[name];
          await this.cleanupScrollback(name);
          changed = true;
        }
      }

      if (changed) {
        await this.write(file);
      }

      return Object.values(file.sessions);
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

      for (const existing of Object.keys(file.sessions)) {
        if (!live.has(existing)) {
          delete file.sessions[existing];
          await this.cleanupScrollback(existing);
        }
      }

      if (file.sessions[name] || live.has(name)) {
        throw shellError("session_exists", "Session already exists", 409);
      }
      if (Object.keys(file.sessions).length >= this.maxSessions) {
        throw shellError("session_limit", "Session limit reached", 507);
      }

      await this.options.adapter.createSession({ name, cwd, layout: layoutName, cmd: input.cmd });
      const now = new Date().toISOString();
      const session: ShellSession = {
        name,
        status: "active",
        createdAt: now,
        updatedAt: now,
        layoutName,
        tabs: [],
        attachedClients: 0,
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

      return session;
    });
  }

  async delete(name: string, options: { force?: boolean } = {}): Promise<void> {
    return this.withMutationLock(async () => {
      const safeName = validateSessionName(name);
      const file = await this.read();
      if (!file.sessions[safeName]) {
        throw shellError("session_not_found", "Session not found", 404);
      }
      await this.options.adapter.deleteSession(safeName, options);
      delete file.sessions[safeName];
      await this.cleanupScrollback(safeName);
      await this.write(file);
    });
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
