import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { resolveWithinHome } from "./path-security.js";

export type OwnerScope = { type: "user" | "org"; id: string };

export interface WorkspaceOperation {
  id: string;
  type: string;
  status: string;
  projectSlug?: string;
  stagingPath?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceExportRequest {
  scope: "all" | "project";
  projectSlug?: string;
  ownerScope?: OwnerScope;
  includeTranscripts?: boolean;
}

export interface WorkspaceDeleteRequest {
  scope: "project";
  projectSlug: string;
  ownerScope?: OwnerScope;
  confirmation: string;
}

export interface WorkspaceExportManifest {
  id: string;
  createdAt: string;
  scope: WorkspaceExportRequest["scope"];
  files: string[];
}

const DELETE_CONFIRMATION = "delete project workspace data";
const MAX_LOCKS = 256;

const projectLocks = new Map<string, Promise<unknown>>();

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(tmpPath, path);
}

export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

async function listFilesRecursive(root: string, homePath: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    const relativePath = relative(homePath, resolve(fullPath));
    if (entry.isSymbolicLink() || relativePath.startsWith("..") || relativePath === "" || resolve(relativePath) === relativePath) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath, homePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function listOwnedProjectFiles(homePath: string, ownerScope?: OwnerScope): Promise<string[]> {
  const projectsRoot = join(homePath, "projects");
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const projectPath = join(projectsRoot, entry.name);
    const owner = await readOwnerScope(join(projectPath, "config.json"));
    if (!ownerMatches(owner, ownerScope)) continue;
    files.push(...await listFilesRecursive(projectPath, homePath));
  }
  return files;
}

async function readOwnerScope(configPath: string): Promise<OwnerScope | null> {
  try {
    const config = await readJsonFile(configPath);
    if (
      isRecord(config) &&
      isRecord(config.ownerScope) &&
      (config.ownerScope.type === "user" || config.ownerScope.type === "org") &&
      typeof config.ownerScope.id === "string"
    ) {
      return { type: config.ownerScope.type, id: config.ownerScope.id };
    }
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return null;
    }
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  return null;
}

function ownerMatches(actual: OwnerScope | null, expected?: OwnerScope): boolean {
  if (!expected) return true;
  return actual?.type === expected.type && actual.id === expected.id;
}

function evictOldestLockIfNeeded(): void {
  if (projectLocks.size < MAX_LOCKS) return;
  const oldest = projectLocks.keys().next().value as string | undefined;
  if (oldest) projectLocks.delete(oldest);
}

export async function withProjectLock<T>(projectSlug: string, callback: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectSlug) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const chained = previous.then(() => current);
  evictOldestLockIfNeeded();
  projectLocks.set(projectSlug, chained);

  try {
    await previous.catch((err: unknown) => {
      // Previous lock holder errored; their error is re-thrown to their own caller. Proceed regardless.
      console.error("[withProjectLock] previous lock holder error (swallowed):", err instanceof Error ? err.message : String(err));
    });
    return await callback();
  } finally {
    release();
    if (projectLocks.get(projectSlug) === chained) {
      projectLocks.delete(projectSlug);
    }
  }
}

export function createStateOps(options: { homePath: string; now?: () => string }) {
  const homePath = resolve(options.homePath);
  const opsDir = join(homePath, "system", "ops");

  return {
    async recordOperation(operation: WorkspaceOperation): Promise<void> {
      const timestamp = nowIso(options.now);
      await atomicWriteJson(join(opsDir, `${operation.id}.json`), {
        ...operation,
        createdAt: operation.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    },

    async recoverOperations(): Promise<{ cleanedStaging: string[] }> {
      const cleanedStaging: string[] = [];
      let entries;
      try {
        entries = await readdir(opsDir, { withFileTypes: true });
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { cleanedStaging };
        }
        throw err;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const op = await readJsonFile<WorkspaceOperation>(join(opsDir, entry.name));
        if (op.type !== "clone_project" || op.status !== "staged" || !op.stagingPath) continue;
        const stagingPath = resolve(op.stagingPath);
        const allowedStagingRoot = join(homePath, "system", "clone-staging");
        if (!stagingPath.startsWith(`${allowedStagingRoot}/`)) continue;
        await rm(stagingPath, { recursive: true, force: true });
        cleanedStaging.push(stagingPath);
        await atomicWriteJson(join(opsDir, entry.name), {
          ...op,
          status: "recovered",
          updatedAt: nowIso(options.now),
        });
      }

      return { cleanedStaging };
    },

    async exportWorkspace(request: WorkspaceExportRequest): Promise<WorkspaceExportManifest> {
      const createdAt = nowIso(options.now);
      const files: string[] = [];
      if (request.scope === "all") {
        const systemPath = resolveWithinHome(homePath, "system");
        if (systemPath && await pathExists(systemPath)) {
          files.push(...await listFilesRecursive(systemPath, homePath));
        }
        files.push(...await listOwnedProjectFiles(homePath, request.ownerScope));
      } else if (request.scope === "project") {
        if (!request.projectSlug) {
          return { id: `export_${randomUUID()}`, createdAt, scope: request.scope, files };
        }
        const projectPath = resolveWithinHome(homePath, `projects/${request.projectSlug}`);
        if (!projectPath || !await pathExists(projectPath)) {
          return { id: `export_${randomUUID()}`, createdAt, scope: request.scope, files };
        }
        const owner = await readOwnerScope(join(projectPath, "config.json"));
        if (!ownerMatches(owner, request.ownerScope)) {
          return { id: `export_${randomUUID()}`, createdAt, scope: request.scope, files };
        }
        files.push(...await listFilesRecursive(projectPath, homePath));
      }

      files.sort();
      return { id: `export_${randomUUID()}`, createdAt, scope: request.scope, files };
    },

    async deleteWorkspaceData(request: WorkspaceDeleteRequest): Promise<
      { ok: true } | { ok: false; status: number; error: { code: string; message: string } }
    > {
      if (request.confirmation !== DELETE_CONFIRMATION) {
        return {
          ok: false,
          status: 400,
          error: { code: "confirmation_required", message: "Deletion confirmation is required" },
        };
      }
      const projectPath = resolveWithinHome(homePath, `projects/${request.projectSlug}`);
      if (!projectPath) {
        return {
          ok: false,
          status: 400,
          error: { code: "delete_scope_invalid", message: "Delete scope is invalid" },
        };
      }
      const owner = await readOwnerScope(join(projectPath, "config.json"));
      if (!ownerMatches(owner, request.ownerScope)) {
        return {
          ok: false,
          status: 404,
          error: { code: "not_found", message: "Workspace data was not found" },
        };
      }
      await rm(projectPath, { recursive: true, force: true });
      return { ok: true };
    },
  };
}
