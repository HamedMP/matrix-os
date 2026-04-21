import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const MATRIXOS_TEMP_FILE_SUFFIX = /\.(?:\d+\.\d+|matrixos-[0-9a-f-]{36})\.tmp$/i;
const TEMP_CLEANUP_MAX_DEPTH = 64;
const TEMP_CLEANUP_MAX_ENTRIES = 10_000;

interface TempCleanupLogger {
  warn: (msg: string, err?: unknown) => void;
}

export async function cleanupStaleMatrixosTempFiles(
  rootDir: string,
  options?: {
    olderThanMs?: number;
    logger?: TempCleanupLogger;
  },
): Promise<void> {
  const cutoff = Date.now() - (options?.olderThanMs ?? 60_000);
  const logger = options?.logger;
  let visited = 0;
  let capped = false;

  const walk = async (dir: string, depth = 0): Promise<void> => {
    if (capped || depth > TEMP_CLEANUP_MAX_DEPTH) {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      visited++;
      if (visited > TEMP_CLEANUP_MAX_ENTRIES) {
        capped = true;
        logger?.warn(
          `Temp file cleanup stopped after scanning ${TEMP_CLEANUP_MAX_ENTRIES.toLocaleString()} entries under ${rootDir}`,
        );
        return;
      }

      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath, depth + 1);
        if (capped) return;
        continue;
      }
      if (!entry.isFile() || !MATRIXOS_TEMP_FILE_SUFFIX.test(entry.name)) {
        continue;
      }

      let stats;
      try {
        stats = await lstat(absPath);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          continue;
        }
        throw err;
      }
      if (!stats.isFile() || stats.mtimeMs > cutoff) {
        continue;
      }
      try {
        await unlink(absPath);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          continue;
        }
        logger?.warn(`Failed to delete stale temp file ${absPath}`, err);
      }
    }
  };

  await walk(rootDir);
}
