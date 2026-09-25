import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const LOCAL_WALK_FILE_CAP = 50_000;
const LOCAL_WALK_DEPTH_CAP = 64;
const HOME_MIRROR_TMP_SUFFIX = /\.(?:\d+|matrixos-[0-9a-f-]{36})\.tmp$/i;

export interface WalkFilters {
  /** Directory traversal decision (see shouldPruneHomeMirrorPath). */
  pruned: (relPath: string) => boolean;
  /** File-level ignore decision (see isHomeMirrorIgnored). */
  ignored: (relPath: string) => boolean;
  log: { error: (msg: string, ...args: unknown[]) => void };
}

export async function cleanupTempFiles(
  dir: string,
  filters: WalkFilters,
  relDir = "",
  depth = 0,
): Promise<void> {
  if (depth > LOCAL_WALK_DEPTH_CAP) {
    throw new Error(
      `temp file cleanup exceeded max depth of ${LOCAL_WALK_DEPTH_CAP}`,
    );
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relDir ? join(relDir, entry.name) : entry.name;
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (filters.pruned(relPath)) continue;
      await cleanupTempFiles(absPath, filters, relPath, depth + 1);
      continue;
    }
    if (entry.isFile() && HOME_MIRROR_TMP_SUFFIX.test(entry.name)) {
      try {
        await unlink(absPath);
      } catch (err: unknown) {
        if (
          !(err instanceof Error) ||
          !("code" in err) ||
          (err as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          filters.log.error(
            `cleanup failed for orphaned temp ${relPath}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }
}

export async function collectLocalFiles(
  dir: string,
  filters: WalkFilters,
  relDir = "",
  files: string[] = [],
  depth = 0,
): Promise<string[]> {
  if (depth > LOCAL_WALK_DEPTH_CAP) {
    throw new Error(
      `local file walk exceeded max depth of ${LOCAL_WALK_DEPTH_CAP}`,
    );
  }
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = relDir ? join(relDir, entry.name) : entry.name;
    const absPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Owner-ignored directories stay walkable while a negation could
      // re-include a descendant; files below are still filtered one by one.
      if (filters.pruned(relPath)) continue;
      await collectLocalFiles(absPath, filters, relPath, files, depth + 1);
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile()) {
      if (filters.ignored(relPath)) continue;
      files.push(relPath);
      if (files.length > LOCAL_WALK_FILE_CAP) {
        throw new Error(
          `local file walk exceeded ${LOCAL_WALK_FILE_CAP.toLocaleString()} files`,
        );
      }
    }
  }

  return files;
}
