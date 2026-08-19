import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { resolveWithinHome } from "./path-security.js";
import { isMatrixManagedProjectSource } from "./project-registry-layout.js";
import type { ProjectRegistry } from "./project-registry.js";
import {
  listValidatedLegacyProjectStateFiles,
  removeValidatedLegacyProjectState,
} from "./legacy-project-state.js";
import { projectStateRecoveryDir } from "./bounded-json-file.js";

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

export class ProjectLockCapacityError extends Error {
  constructor() {
    super("Project operation capacity reached");
    this.name = "ProjectLockCapacityError";
  }
}

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
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
  const registry = await getProjectRegistry(homePath);
  const projectsRoot = join(homePath, "projects");
  const slugs = projectSlug && PROJECT_SLUG_REGEX.test(projectSlug)
    ? new Set([projectSlug])
    : new Set([
        ...await registry.listSlugs(),
        ...await registry.listTombstoneSlugs(),
      ]);

  const files: string[] = [];
  for (const slug of slugs) {
    const config = await registry.readConfig(slug);
    const tombstone = await registry.readTombstone(slug);
    const configOwned = config && ownerMatches(config.ownerScope, ownerScope);
    const tombstoneOwned = tombstone && ownerMatches(tombstone.ownerScope, ownerScope);
    if (!configOwned && !tombstoneOwned) continue;

    const canonicalDir = registry.recordDir(slug);
    if (configOwned && await pathExists(canonicalDir)) {
      files.push(...await listFilesRecursive(canonicalDir, homePath));
    }

    const canonicalTombstonePath = registry.tombstonePath(slug);
    if (tombstoneOwned && await pathExists(canonicalTombstonePath)) {
      files.push(relative(homePath, canonicalTombstonePath));
    }

    if (!configOwned) continue;

    for (const legacyStatePath of await listValidatedLegacyProjectStateFiles({
      projectSlug: slug,
      tasksDir: registry.legacyTasksDir(slug),
      previewsDir: registry.legacyPreviewsDir(slug),
    })) {
      files.push(relative(homePath, legacyStatePath));
    }
    const localPath = resolve(config.localPath);
    const resolvedHome = resolve(homePath);
    const rel = relative(resolvedHome, localPath);
    if (rel.startsWith("..") || rel === "" || resolve(rel) === rel || !await pathExists(localPath)) continue;
    files.push(...await listFilesRecursive(localPath, homePath));
  }
  return [...new Set(files)];
}

async function getProjectRegistry(homePath: string): Promise<ProjectRegistry> {
  // project-registry owns validation and compatibility adoption, while it
  // imports the atomic JSON primitives above. Resolve it lazily to avoid a
  // runtime module cycle without duplicating the project-record schema here.
  const { createProjectRegistry } = await import("./project-registry.js");
  return createProjectRegistry({ homePath });
}

function ownerMatches(actual: OwnerScope | null, expected?: OwnerScope): boolean {
  if (!expected) return true;
  return actual?.type === expected.type && actual.id === expected.id;
}

export async function withProjectLock<T>(projectSlug: string, callback: () => Promise<T>): Promise<T> {
  const existing = projectLocks.get(projectSlug);
  if (!existing && projectLocks.size >= MAX_LOCKS) {
    throw new ProjectLockCapacityError();
  }
  const previous = existing ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const chained = previous.then(() => current);
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
      return await withProjectLock(request.projectSlug, async () => {
        const registry = await getProjectRegistry(homePath);
        const config = await registry.readConfig(request.projectSlug);
        const tombstone = await registry.readTombstone(request.projectSlug);
        if (
          (!config && !tombstone)
          || (config && !ownerMatches(config.ownerScope, request.ownerScope))
          || (tombstone && !ownerMatches(tombstone.ownerScope, request.ownerScope))
        ) {
          return {
            ok: false as const,
            status: 404,
            error: { code: "not_found", message: "Workspace data was not found" },
          };
        }
        const legacyProjectPath = resolveWithinHome(homePath, `projects/${request.projectSlug}`);
        if (!legacyProjectPath) {
          return {
            ok: false as const,
            status: 400,
            error: { code: "delete_scope_invalid", message: "Delete scope is invalid" },
          };
        }
        if (config && isMatrixManagedProjectSource(homePath, config)) {
          await rm(legacyProjectPath, { recursive: true, force: true });
        }
        await removeValidatedLegacyProjectState({
          projectSlug: request.projectSlug,
          tasksDir: registry.legacyTasksDir(request.projectSlug),
          previewsDir: registry.legacyPreviewsDir(request.projectSlug),
          recoveryDir: projectStateRecoveryDir(homePath),
        });
        await registry.removeConfig(request.projectSlug);
        await registry.removeTombstone(request.projectSlug, tombstone ?? config!);
        return { ok: true as const };
      });
    },
  };
}
