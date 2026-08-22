import { constants, type Dirent } from "node:fs";
import { access, link, lstat, mkdir, opendir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { atomicCreateJson, atomicWriteJson } from "./state-ops.js";
import {
  projectStateRecoveryDir,
  readBoundedJsonFileWithIdentity,
  removeFileIfUnchanged,
  type FileIdentity,
} from "./bounded-json-file.js";
import {
  containsDeniedFileApiPath,
  isProtectedHomeSubpath,
  resolveWithinHome,
  resolveWritableFileApiPath,
} from "./path-security.js";

export const PROJECT_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ProjectRecordSchema = z.object({
  id: z.string().regex(/^proj_[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(1_000).optional(),
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
  legacyKindInferred: z.literal(true).optional(),
  github: z.object({
    owner: z.string().min(1).max(256),
    repo: z.string().min(1).max(256),
    htmlUrl: z.string().min(1).max(2_048),
    authState: z.enum(["unknown", "ok", "required", "rate_limited", "error"]),
    lastPrRefreshAt: z.string().max(64).optional(),
    lastBranchRefreshAt: z.string().max(64).optional(),
  }).optional(),
});

const MAX_PROJECT_RECORD_BYTES = 256 * 1024;
const MAX_PROJECT_DISCOVERY_ENTRIES = 10_000;

export interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
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
  legacyKindInferred?: true;
  github?: {
    owner: string;
    repo: string;
    htmlUrl: string;
    authState: "unknown" | "ok" | "required" | "rate_limited" | "error";
    lastPrRefreshAt?: string;
    lastBranchRefreshAt?: string;
  };
}

async function parseProjectRecord(
  value: unknown,
  slug: string,
  homePath: string,
): Promise<ProjectRecord | null> {
  const parsed = ProjectRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.slug !== slug) return null;
  const localPath = resolve(parsed.data.localPath);
  const realHomePath = await realpath(homePath);
  const validationBase = resolveWithinHome(homePath, localPath)
    ? homePath
    : resolveWithinHome(realHomePath, localPath)
      ? realHomePath
      : null;
  if (
    !validationBase
    || isProtectedHomeSubpath(validationBase, localPath)
    || containsDeniedFileApiPath(validationBase, localPath)
    || !resolveWritableFileApiPath(validationBase, localPath)
  ) {
    return null;
  }
  try {
    const stats = await lstat(localPath);
    if (stats.isSymbolicLink()) return null;
    const realLocalPath = await realpath(localPath);
    if (
      !resolveWithinHome(realHomePath, realLocalPath)
      || isProtectedHomeSubpath(realHomePath, realLocalPath)
      || containsDeniedFileApiPath(realHomePath, realLocalPath)
    ) {
      return null;
    }
  } catch (error: unknown) {
    // Missing owner code stays representable for recovery and diagnostics;
    // existing paths must resolve inside the owner-controlled Matrix home.
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
  return parsed.data;
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
  const candidate = await readBoundedJsonFileWithIdentity(path, MAX_PROJECT_RECORD_BYTES);
  return candidate ? candidate.value as T : null;
}

async function listBoundedNames(
  path: string,
  include: (entry: Dirent) => boolean,
  mapName: (name: string) => string = (name) => name,
): Promise<string[]> {
  try {
    const directory = await opendir(path);
    const names: string[] = [];
    let visited = 0;
    for await (const entry of directory) {
      visited += 1;
      if (visited > MAX_PROJECT_DISCOVERY_ENTRIES) {
        throw new Error("Project registry discovery limit exceeded");
      }
      if (include(entry)) names.push(mapName(entry.name));
    }
    return names;
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function listDirectoryNames(path: string): Promise<string[]> {
  return await listBoundedNames(path, (entry) => entry.isDirectory() && !entry.isSymbolicLink());
}

async function listJsonNames(path: string): Promise<string[]> {
  return await listBoundedNames(
    path,
    (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"),
    (name) => name.slice(0, -".json".length),
  );
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

  const readLegacyConfigCandidate = async <T extends ProjectRecord = ProjectRecord>(slug: string): Promise<{
    record: T;
    identity: FileIdentity;
  } | null> => {
    const legacyPath = legacyConfigPath(slug);
    const candidate = await readBoundedJsonFileWithIdentity(legacyPath, MAX_PROJECT_RECORD_BYTES);
    if (!candidate) return null;
    const parsed = await parseProjectRecord(candidate.value, slug, homePath);
    return parsed ? { record: parsed as T, identity: candidate.identity } : null;
  };

  const readLegacyConfig = async <T extends ProjectRecord = ProjectRecord>(slug: string): Promise<T | null> =>
    (await readLegacyConfigCandidate<T>(slug))?.record ?? null;

  const readLegacyTombstoneCandidate = async (slug: string): Promise<{
    record: ProjectRecord;
    identity: FileIdentity;
  } | null> => {
    const candidate = await readBoundedJsonFileWithIdentity(
      legacyTombstonePath(slug),
      MAX_PROJECT_RECORD_BYTES,
    );
    if (!candidate) return null;
    const parsed = await parseProjectRecord(candidate.value, slug, homePath);
    return parsed ? { record: parsed, identity: candidate.identity } : null;
  };

  const readCanonicalTombstoneCandidate = async (slug: string): Promise<{
    record: ProjectRecord;
    identity: FileIdentity;
  } | null> => {
    const candidate = await readBoundedJsonFileWithIdentity(tombstonePath(slug), MAX_PROJECT_RECORD_BYTES);
    if (!candidate) return null;
    const parsed = await parseProjectRecord(candidate.value, slug, homePath);
    return parsed ? { record: parsed, identity: candidate.identity } : null;
  };

  const sameProjectOwner = (record: ProjectRecord, expected: ProjectRecord): boolean => (
    record.id === expected.id
    && record.ownerScope.type === expected.ownerScope.type
    && record.ownerScope.id === expected.ownerScope.id
  );

  const archiveMatchingLegacy = async (slug: string, canonical: ProjectRecord): Promise<void> => {
    const legacyPath = legacyConfigPath(slug);
    const candidate = await readLegacyConfigCandidate<ProjectRecord>(slug);
    if (!candidate) return;
    const legacy = candidate.record;
    if (legacy.id !== canonical.id || legacy.slug !== canonical.slug) return;

    await mkdir(recordDir(slug), { recursive: true });
    const backupPath = legacyBackupPath(slug);
    let createdBackup = false;
    try {
      await link(legacyPath, backupPath);
      createdBackup = true;
    } catch (error: unknown) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
    }
    const backupCandidate = await readBoundedJsonFileWithIdentity(backupPath, MAX_PROJECT_RECORD_BYTES);
    const backup = backupCandidate
      ? await parseProjectRecord(backupCandidate.value, slug, homePath)
      : null;
    if (!backup || backup.id !== legacy.id || backup.slug !== legacy.slug) {
      if (createdBackup && backupCandidate) {
        await removeFileIfUnchanged(backupPath, backupCandidate.identity, {
          recoveryDir: projectStateRecoveryDir(homePath),
        });
      }
      return;
    }
    await removeFileIfUnchanged(legacyPath, candidate.identity, {
      recoveryDir: projectStateRecoveryDir(homePath),
    });
  };

  const readConfig = async <T extends ProjectRecord = ProjectRecord>(slug: string): Promise<T | null> => {
    const canonical = await readIfPresent<unknown>(configPath(slug));
    if (canonical) {
      const parsed = await parseProjectRecord(canonical, slug, homePath);
      if (!parsed) return null;
      await archiveMatchingLegacy(slug, parsed);
      return parsed as T;
    }

    const legacyCandidate = await readLegacyConfigCandidate<T>(slug);
    if (!legacyCandidate) return null;
    const legacy = legacyCandidate.record;
    const created = await atomicCreateJson(configPath(slug), legacy);
    const winner: unknown = created ? legacy : await readIfPresent(configPath(slug));
    const parsed = await parseProjectRecord(winner, slug, homePath);
    if (!parsed) return null;
    await archiveMatchingLegacy(slug, parsed);
    return parsed as T;
  };

  const readTombstone = async <T extends ProjectRecord = ProjectRecord>(slug: string): Promise<T | null> => {
    const canonical = await readIfPresent<unknown>(tombstonePath(slug));
    if (canonical) {
      const parsed = await parseProjectRecord(canonical, slug, homePath);
      return parsed ? parsed as T : null;
    }
    const legacyCandidate = await readLegacyTombstoneCandidate(slug);
    if (!legacyCandidate) return null;
    const created = await atomicCreateJson(tombstonePath(slug), legacyCandidate.record);
    const winner: unknown = created ? legacyCandidate.record : await readIfPresent(tombstonePath(slug));
    const parsedWinner = await parseProjectRecord(winner, slug, homePath);
    return parsedWinner ? parsedWinner as T : null;
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
      const parsed = await parseProjectRecord(value, slug, homePath);
      if (!parsed) throw new Error("Invalid project registry record");
      return await atomicCreateJson(configPath(slug), parsed);
    },

    async writeConfig<T extends ProjectRecord>(slug: string, value: T): Promise<void> {
      const parsed = await parseProjectRecord(value, slug, homePath);
      if (!parsed) throw new Error("Invalid project registry record");
      await atomicWriteJson(configPath(slug), parsed);
      await archiveMatchingLegacy(slug, parsed);
    },

    async removeConfig(slug: string): Promise<void> {
      await rm(recordDir(slug), { recursive: true, force: true });
    },

    async hasTombstone(slug: string): Promise<boolean> {
      return await readTombstone(slug) !== null;
    },

    readTombstone,

    async writeTombstone<T extends ProjectRecord>(slug: string, value: T): Promise<void> {
      const parsed = await parseProjectRecord(value, slug, homePath);
      if (!parsed) throw new Error("Invalid project tombstone record");
      const legacy = await readLegacyTombstoneCandidate(slug);
      await atomicWriteJson(tombstonePath(slug), parsed);
      if (legacy && sameProjectOwner(legacy.record, parsed)) {
        await removeFileIfUnchanged(legacyTombstonePath(slug), legacy.identity, {
          recoveryDir: projectStateRecoveryDir(homePath),
        });
      }
    },

    async removeTombstone(slug: string, expected: ProjectRecord): Promise<void> {
      const canonical = await readCanonicalTombstoneCandidate(slug);
      const legacy = await readLegacyTombstoneCandidate(slug);
      if (canonical && sameProjectOwner(canonical.record, expected)) {
        await removeFileIfUnchanged(tombstonePath(slug), canonical.identity, {
          recoveryDir: projectStateRecoveryDir(homePath),
        });
      }
      if (legacy && sameProjectOwner(legacy.record, expected)) {
        await removeFileIfUnchanged(legacyTombstonePath(slug), legacy.identity, {
          recoveryDir: projectStateRecoveryDir(homePath),
        });
      }
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
