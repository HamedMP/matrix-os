import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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
const PROJECT_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

// Publish a fully written JSON file without replacing an existing file. The
// hard-link is atomic on the same filesystem, so concurrent writers either
// publish one complete value or observe EEXIST and reconcile with the winner.
export async function atomicCreateJson(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await link(tmpPath, path);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  } finally {
    await rm(tmpPath, { force: true });
  }
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

async function listOwnedProjectFiles(
  homePath: string,
  ownerScope?: OwnerScope,
  projectSlug?: string,
): Promise<string[]> {
  const registryRoot = join(homePath, "system", "projects");
  const projectsRoot = join(homePath, "projects");
  const slugs = projectSlug && PROJECT_SLUG_REGEX.test(projectSlug)
    ? new Set([projectSlug])
    : new Set<string>();
  if (!projectSlug) {
    for (const root of [registryRoot, projectsRoot]) {
      try {
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && PROJECT_SLUG_REGEX.test(entry.name)) {
            slugs.add(entry.name);
          }
        }
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
          throw err;
        }
      }
    }
  }

  const files: string[] = [];
  for (const slug of slugs) {
    const canonicalDir = join(registryRoot, slug);
    const canonicalConfigPath = join(canonicalDir, "config.json");
    const legacyConfigPath = join(projectsRoot, slug, "config.json");
    const configPath = await pathExists(canonicalConfigPath) ? canonicalConfigPath : legacyConfigPath;
    const owner = await readOwnerScope(configPath);
    if (!ownerMatches(owner, ownerScope)) continue;

    if (await pathExists(canonicalDir)) {
      files.push(...await listFilesRecursive(canonicalDir, homePath));
    } else if (await pathExists(legacyConfigPath)) {
      files.push(relative(homePath, legacyConfigPath));
    }

    for (const tombstonePath of [
      join(registryRoot, ".deleting", `${slug}.json`),
      join(projectsRoot, ".deleting", `${slug}.json`),
    ]) {
      if (await pathExists(tombstonePath)
        && ownerMatches(await readOwnerScope(tombstonePath), ownerScope)) {
        files.push(relative(homePath, tombstonePath));
      }
    }

    let config: Record<string, unknown> | null = null;
    try {
      const value = await readJsonFile(configPath);
      config = isRecord(value) ? value : null;
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    const localPath = typeof config?.localPath === "string" ? resolve(config.localPath) : null;
    if (!localPath) continue;
    const legacyProjectRoot = join(projectsRoot, slug);
    const legacyManaged = config?.kind === "scratch"
      || config?.kind === "github"
      || (config?.kind === undefined
        && (localPath === legacyProjectRoot || localPath.startsWith(`${legacyProjectRoot}${sep}`)));
    if (legacyManaged) {
      for (const stateName of ["tasks", "previews"]) {
        const legacyStateDir = join(legacyProjectRoot, stateName);
        if (await pathExists(legacyStateDir)) {
          files.push(...await listFilesRecursive(legacyStateDir, homePath));
        }
      }
    }
    const resolvedHome = resolve(homePath);
    const rel = relative(resolvedHome, localPath);
    if (rel.startsWith("..") || rel === "" || resolve(rel) === rel || !await pathExists(localPath)) continue;
    files.push(...await listFilesRecursive(localPath, homePath));
  }
  return [...new Set(files)];
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
          files.push(...(await listFilesRecursive(systemPath, homePath))
            .filter((path) => !path.startsWith("system/projects/")));
        }
        files.push(...await listOwnedProjectFiles(homePath, request.ownerScope));
      } else if (request.scope === "project") {
        if (!request.projectSlug) {
          return { id: `export_${randomUUID()}`, createdAt, scope: request.scope, files };
        }
        files.push(...await listOwnedProjectFiles(homePath, request.ownerScope, request.projectSlug));
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
      if (!PROJECT_SLUG_REGEX.test(request.projectSlug)) {
        return {
          ok: false,
          status: 400,
          error: { code: "delete_scope_invalid", message: "Delete scope is invalid" },
        };
      }
      const registryPath = resolveWithinHome(homePath, `system/projects/${request.projectSlug}`);
      const legacyProjectPath = resolveWithinHome(homePath, `projects/${request.projectSlug}`);
      if (!registryPath || !legacyProjectPath) {
        return {
          ok: false,
          status: 400,
          error: { code: "delete_scope_invalid", message: "Delete scope is invalid" },
        };
      }
      const canonicalConfigPath = join(registryPath, "config.json");
      const legacyConfigPath = join(legacyProjectPath, "config.json");
      const configPath = await pathExists(canonicalConfigPath) ? canonicalConfigPath : legacyConfigPath;
      const owner = await readOwnerScope(configPath);
      if (!ownerMatches(owner, request.ownerScope)) {
        return {
          ok: false,
          status: 404,
          error: { code: "not_found", message: "Workspace data was not found" },
        };
      }
      const config = await readJsonFile<Record<string, unknown>>(configPath);
      if (config.kind === "scratch" || config.kind === "github") {
        await rm(legacyProjectPath, { recursive: true, force: true });
      } else if (configPath === legacyConfigPath) {
        // Missing kind is legacy ambiguous state. Prefer leaving owner source
        // behind over guessing that the whole directory is Matrix-managed.
        await rm(legacyConfigPath, { force: true });
      }
      await rm(registryPath, { recursive: true, force: true });
      return { ok: true };
    },
  };
}
