import { constants } from "node:fs";
import { access, link, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { atomicCreateJson, atomicWriteJson, readJsonFile } from "./state-ops.js";

export const PROJECT_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ProjectRecordSchema = z.object({
  id: z.string().regex(/^proj_[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(200),
  slug: z.string().regex(PROJECT_SLUG_REGEX),
  kind: z.enum(["scratch", "github", "folder"]).optional(),
  remote: z.string().max(2_048).optional(),
  localPath: z.string().min(1).max(4_096),
  defaultBranch: z.string().max(200).optional(),
  addedAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  ownerScope: z.object({
    type: z.enum(["user", "org"]),
    id: z.string().min(1).max(256),
  }),
  archivedAt: z.string().max(64).optional(),
  deletingAt: z.string().max(64).optional(),
  createRequestId: z.string().max(132).optional(),
  createRequestFingerprint: z.string().max(128).optional(),
  github: z.object({
    owner: z.string().min(1).max(256),
    repo: z.string().min(1).max(256),
    htmlUrl: z.string().min(1).max(2_048),
    authState: z.enum(["unknown", "ok", "required", "rate_limited", "error"]),
    lastPrRefreshAt: z.string().max(64).optional(),
    lastBranchRefreshAt: z.string().max(64).optional(),
  }).optional(),
}).passthrough();

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  kind?: "scratch" | "github" | "folder";
  remote?: string;
  localPath: string;
  defaultBranch?: string;
  addedAt: string;
  updatedAt: string;
  ownerScope: { type: "user" | "org"; id: string };
  archivedAt?: string;
  deletingAt?: string;
  createRequestId?: string;
  createRequestFingerprint?: string;
  github?: {
    owner: string;
    repo: string;
    htmlUrl: string;
    authState: "unknown" | "ok" | "required" | "rate_limited" | "error";
    lastPrRefreshAt?: string;
    lastBranchRefreshAt?: string;
  };
}

function isProjectRecord(value: unknown, slug: string): value is ProjectRecord {
  const parsed = ProjectRecordSchema.safeParse(value);
  return parsed.success && parsed.data.slug === slug;
}

function validatedSlug(slug: string): string {
  if (!PROJECT_SLUG_REGEX.test(slug)) {
    throw new Error("Invalid project registry slug");
  }
  return slug;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function readIfPresent<T>(path: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(path);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function listDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function listJsonNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length));
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
}

/**
 * Matrix-owned project state. Callers use this module instead of rebuilding
 * paths so compatibility adoption and the owner-workspace seam stay local.
 */
export function createProjectRegistry(options: { homePath: string }) {
  const homePath = resolve(options.homePath);
  const root = join(homePath, "system", "projects");
  const ownerProjectsRoot = join(homePath, "projects");

  const recordDir = (slug: string) => join(root, validatedSlug(slug));
  const configPath = (slug: string) => join(recordDir(slug), "config.json");
  const legacyConfigPath = (slug: string) => join(ownerProjectsRoot, validatedSlug(slug), "config.json");
  const legacyBackupPath = (slug: string) => join(recordDir(slug), "legacy-config.json");
  const tombstoneDir = () => join(root, ".deleting");
  const tombstonePath = (slug: string) => join(tombstoneDir(), `${validatedSlug(slug)}.json`);
  const legacyTombstoneDir = () => join(ownerProjectsRoot, ".deleting");
  const legacyTombstonePath = (slug: string) => join(legacyTombstoneDir(), `${validatedSlug(slug)}.json`);
  const tasksDir = (slug: string) => join(recordDir(slug), "tasks");
  const legacyTasksDir = (slug: string) => join(ownerProjectsRoot, validatedSlug(slug), "tasks");
  const previewsDir = (slug: string) => join(recordDir(slug), "previews");
  const legacyPreviewsDir = (slug: string) => join(ownerProjectsRoot, validatedSlug(slug), "previews");
  const worktreesDir = (slug: string) => join(recordDir(slug), "worktrees");

  const readLegacyConfig = async <T extends ProjectRecord = ProjectRecord>(slug: string): Promise<T | null> => {
    const legacyPath = legacyConfigPath(slug);
    let stats;
    try {
      stats = await lstat(legacyPath);
    } catch (error: unknown) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    let value: unknown;
    try {
      value = await readJsonFile(legacyPath);
    } catch (error: unknown) {
      // projects/<folder> is owner space. A same-named application config is
      // legacy Matrix metadata only when it has the expected record identity.
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    return isProjectRecord(value, slug) ? value as T : null;
  };

  const archiveMatchingLegacy = async (slug: string, canonical: ProjectRecord): Promise<void> => {
    const legacyPath = legacyConfigPath(slug);
    let stats;
    try {
      stats = await lstat(legacyPath);
    } catch (error: unknown) {
      if (isErrnoCode(error, "ENOENT")) return;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const legacy = await readLegacyConfig<ProjectRecord>(slug);
    if (!legacy || legacy.id !== canonical.id || legacy.slug !== canonical.slug) return;

    await mkdir(recordDir(slug), { recursive: true });
    const backupPath = legacyBackupPath(slug);
    try {
      await link(legacyPath, backupPath);
    } catch (error: unknown) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      const backup = await readIfPresent<ProjectRecord>(backupPath);
      if (!backup || backup.id !== legacy.id || backup.slug !== legacy.slug) return;
    }
    await unlink(legacyPath).catch((error: unknown) => {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    });
  };

  const readConfig = async <T extends ProjectRecord = ProjectRecord>(slug: string): Promise<T | null> => {
    const canonical = await readIfPresent<unknown>(configPath(slug));
    if (canonical) {
      if (!isProjectRecord(canonical, slug)) return null;
      await archiveMatchingLegacy(slug, canonical);
      return canonical as T;
    }

    const legacy = await readLegacyConfig<T>(slug);
    if (!legacy) return null;
    const created = await atomicCreateJson(configPath(slug), legacy);
    const winner: unknown = created ? legacy : await readJsonFile(configPath(slug));
    if (!isProjectRecord(winner, slug)) return null;
    await archiveMatchingLegacy(slug, winner);
    return winner as T;
  };

  const readTombstone = async <T extends ProjectRecord = ProjectRecord>(slug: string): Promise<T | null> => {
    const canonical = await readIfPresent<unknown>(tombstonePath(slug));
    if (canonical) return isProjectRecord(canonical, slug) ? canonical as T : null;
    const legacy = await readIfPresent<unknown>(legacyTombstonePath(slug));
    if (!legacy || !isProjectRecord(legacy, slug)) return null;
    const created = await atomicCreateJson(tombstonePath(slug), legacy);
    const winner: unknown = created ? legacy : await readJsonFile(tombstonePath(slug));
    return isProjectRecord(winner, slug) ? winner as T : null;
  };

  return {
    root,
    recordDir,
    configPath,
    legacyConfigPath,
    legacyBackupPath,
    tombstoneDir,
    tombstonePath,
    legacyTombstoneDir,
    legacyTombstonePath,
    tasksDir,
    legacyTasksDir,
    previewsDir,
    legacyPreviewsDir,
    worktreesDir,

    readConfig,

    async createConfig<T extends ProjectRecord>(slug: string, value: T): Promise<boolean> {
      if (!isProjectRecord(value, slug)) throw new Error("Invalid project registry record");
      return await atomicCreateJson(configPath(slug), value);
    },

    async writeConfig<T extends ProjectRecord>(slug: string, value: T): Promise<void> {
      if (!isProjectRecord(value, slug)) throw new Error("Invalid project registry record");
      await atomicWriteJson(configPath(slug), value);
      await archiveMatchingLegacy(slug, value);
    },

    async removeConfig(slug: string): Promise<void> {
      await rm(recordDir(slug), { recursive: true, force: true });
    },

    async hasTombstone(slug: string): Promise<boolean> {
      return await readTombstone(slug) !== null;
    },

    readTombstone,

    async writeTombstone<T extends ProjectRecord>(slug: string, value: T): Promise<void> {
      if (!isProjectRecord(value, slug)) throw new Error("Invalid project tombstone record");
      await atomicWriteJson(tombstonePath(slug), value);
      await rm(legacyTombstonePath(slug), { force: true });
    },

    async removeTombstone(slug: string): Promise<void> {
      await Promise.all([
        rm(tombstonePath(slug), { force: true }),
        rm(legacyTombstonePath(slug), { force: true }),
      ]);
    },

    async listTombstoneSlugs(): Promise<string[]> {
      const names = await Promise.all([
        listJsonNames(tombstoneDir()),
        listJsonNames(legacyTombstoneDir()),
      ]);
      return [...new Set(names.flat())].filter((slug) => PROJECT_SLUG_REGEX.test(slug)).sort();
    },

    async listSlugs(): Promise<string[]> {
      const [canonicalNames, legacyNames] = await Promise.all([
        listDirectoryNames(root),
        listDirectoryNames(ownerProjectsRoot),
      ]);
      const candidates = [...new Set([...canonicalNames, ...legacyNames])]
        .filter((slug) => PROJECT_SLUG_REGEX.test(slug));
      const present: string[] = [];
      for (const slug of candidates) {
        if (await pathExists(configPath(slug)) || await readLegacyConfig(slug)) {
          present.push(slug);
        }
      }
      return present.sort();
    },
  };
}

export type ProjectRegistry = ReturnType<typeof createProjectRegistry>;
