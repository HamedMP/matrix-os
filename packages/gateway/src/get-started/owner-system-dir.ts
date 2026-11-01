import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { writeUtf8FileAtomic } from "../shell/atomic-write.js";

/** `system/` is missing its plain-directory identity, or changed while pinned. */
export class UnsafeOwnerSystemDirError extends Error {
  constructor() {
    super("Owner system directory is not a pinned plain directory");
    this.name = "UnsafeOwnerSystemDirError";
  }
}

export interface PinnedSystemDir {
  /** The entry itself (never followed), or null when it does not exist. */
  lstat(name: string): Promise<Stats | null>;
  /** A regular file's text, or null when it does not exist. */
  readFile(name: string, maxBytes: number): Promise<string | null>;
  writeAtomic(name: string, text: string, mode: number): Promise<void>;
  /** Atomically creates a complete file only when none exists; false if one already does. */
  createExclusive(name: string, text: string): Promise<boolean>;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * Spec 635: owner setup files live in `<home>/system`. The directory is opened with
 * O_DIRECTORY | O_NOFOLLOW and pinned for `use`, like the owner SOUL writer: on Linux every
 * read, staging write and rename resolves through the descriptor, and every host also
 * revalidates the directory identity before trusting a read or committing a write, so a
 * `system` replaced by a symlink can never redirect them. Null when `system` does not exist.
 */
export async function withPinnedSystemDir<T>(homePath: string, use: (dir: PinnedSystemDir) => Promise<T>): Promise<T | null> {
  const system = join(await realpath(homePath), "system");
  let parent: Stats;
  try { parent = await lstat(system); }
  catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new UnsafeOwnerSystemDirError();
  let directory: FileHandle;
  try { directory = await open(system, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error: unknown) {
    if (["ELOOP", "ENOTDIR"].includes(errorCode(error) ?? "")) throw new UnsafeOwnerSystemDirError();
    throw error;
  }
  try {
    const assertUnchanged = async () => {
      if (!sameFile(parent, await lstat(system)) || await realpath(system) !== system) throw new UnsafeOwnerSystemDirError();
    };
    if (!sameFile(parent, await directory.stat())) throw new UnsafeOwnerSystemDirError();
    await assertUnchanged();
    const base = process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : system;
    const path = (name: string) => join(base, name);
    return await use({
      async lstat(name) {
        try { return await lstat(path(name)); }
        catch (error: unknown) {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        }
      },
      async readFile(name, maxBytes) {
        let before: Stats;
        try { before = await lstat(path(name)); }
        catch (error: unknown) {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        }
        if (!before.isFile() || before.size > maxBytes) throw new UnsafeOwnerSystemDirError();
        // O_NONBLOCK keeps a substituted FIFO from stalling the open.
        const file = await open(path(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await file.stat();
          if (!opened.isFile() || !sameFile(before, opened) || opened.size > maxBytes) throw new UnsafeOwnerSystemDirError();
          // A fixed-size read: a file that grows past the cap after the checks is refused, not buffered.
          const buffer = Buffer.alloc(maxBytes + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
            if (bytesRead === 0) break;
            bytes += bytesRead;
          }
          if (bytes > maxBytes) throw new UnsafeOwnerSystemDirError();
          await assertUnchanged();
          return buffer.subarray(0, bytes).toString("utf-8");
        } finally { await file.close(); }
      },
      async writeAtomic(name, text, mode) {
        await assertUnchanged();
        await writeUtf8FileAtomic(path(name), text, mode, {
          beforeCommit: assertUnchanged,
          // Off Linux a replaced parent must not redirect cleanup to a foreign directory.
          beforeCleanup: process.platform === "linux" ? undefined : assertUnchanged,
        });
      },
      async createExclusive(name, text) {
        await assertUnchanged();
        try {
          await writeUtf8FileAtomic(path(name), text, 0o644, {
            exclusive: true,
            beforeCommit: assertUnchanged,
            beforeCleanup: process.platform === "linux" ? undefined : assertUnchanged,
          });
          return true;
        } catch (error: unknown) {
          if (errorCode(error) === "EEXIST") return false;
          throw error;
        }
      },
    });
  } finally { await directory.close(); }
}
