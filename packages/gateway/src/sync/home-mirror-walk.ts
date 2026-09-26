import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const LOCAL_WALK_FILE_CAP = 50_000;
const LOCAL_WALK_DEPTH_CAP = 64;
// Only names the mirror itself creates (`<path>.matrixos-<uuid>.tmp`, see
// pullFile). Other `*.tmp` files belong to the owner and are never removed.
const HOME_MIRROR_TMP_SUFFIX =
  /\.matrixos-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export interface WalkFilters {
  /** Directory traversal decision (see shouldPruneHomeMirrorPath). */
  pruned: (relPath: string) => boolean;
  /** File-level ignore decision (see isHomeMirrorIgnored). */
  ignored: (relPath: string) => boolean;
  log: { error: (msg: string, ...args: unknown[]) => void };
  /** Aborts an in-progress walk during shutdown. */
  signal?: () => AbortSignal | undefined;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Remove orphaned home-mirror temp files. Entries are re-checked with
 * `lstat()` so symlinks or swapped entries are never unlinked, and files
 * younger than `minAgeMs` are kept so in-flight downloads survive periodic
 * sweeps (startup passes 0 because no download can be in flight yet).
 */
export async function cleanupTempFiles(
  dir: string,
  filters: WalkFilters,
  minAgeMs: number,
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
      await cleanupTempFiles(absPath, filters, minAgeMs, relPath, depth + 1);
      continue;
    }
    if (!entry.isFile() || !HOME_MIRROR_TMP_SUFFIX.test(entry.name)) continue;
    try {
      const info = await lstat(absPath);
      if (!info.isFile()) continue;
      if (minAgeMs > 0 && Date.now() - info.mtimeMs < minAgeMs) continue;
      await unlink(absPath);
    } catch (err: unknown) {
      if (!isMissing(err)) {
        filters.log.error(
          `cleanup failed for orphaned temp ${relPath}:`,
          err instanceof Error ? err.message : String(err),
        );
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
  filters.signal?.()?.throwIfAborted();
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    filters.signal?.()?.throwIfAborted();
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
