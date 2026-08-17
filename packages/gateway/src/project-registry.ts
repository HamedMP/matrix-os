import { constants } from "node:fs";
import { access, link, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicCreateJson, atomicWriteJson, readJsonFile } from "./state-ops.js";

export const PROJECT_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

type ProjectRecord = {
  id: string;
  slug: string;
};

function isProjectRecord(value: unknown, slug: string): value is ProjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && record.id.length > 0
    && record.slug === slug
    && PROJECT_SLUG_REGEX.test(slug);
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
  const tasksDir = (slug: string) => join(recordDir(slug), "tasks");
  const worktreesDir = (slug: string) => join(recordDir(slug), "worktrees");

  const readLegacyConfig = async <T extends ProjectRecord>(slug: string): Promise<T | null> => {
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

  const readConfig = async <T extends ProjectRecord>(slug: string): Promise<T | null> => {
    const canonical = await readIfPresent<T>(configPath(slug));
    if (canonical) {
      await archiveMatchingLegacy(slug, canonical);
      return canonical;
    }

    const legacy = await readLegacyConfig<T>(slug);
    if (!legacy) return null;
    const created = await atomicCreateJson(configPath(slug), legacy);
    const winner = created ? legacy : await readJsonFile<T>(configPath(slug));
    await archiveMatchingLegacy(slug, winner);
    return winner;
  };

  return {
    root,
    recordDir,
    configPath,
    legacyConfigPath,
    legacyBackupPath,
    tombstoneDir,
    tombstonePath,
    tasksDir,
    worktreesDir,

    readConfig,

    async createConfig<T extends ProjectRecord>(slug: string, value: T): Promise<boolean> {
      return await atomicCreateJson(configPath(slug), value);
    },

    async writeConfig<T extends ProjectRecord>(slug: string, value: T): Promise<void> {
      await atomicWriteJson(configPath(slug), value);
      await archiveMatchingLegacy(slug, value);
    },

    async removeConfig(slug: string): Promise<void> {
      await rm(recordDir(slug), { recursive: true, force: true });
    },

    async hasTombstone(slug: string): Promise<boolean> {
      return await pathExists(tombstonePath(slug));
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
