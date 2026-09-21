import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const RECOVERY_FILE_PREFIX = "project-state-";
const MAX_RECOVERY_FILES = 100;
const MAX_RECOVERY_SCAN_ENTRIES = 10_000;
let recoveryMutationTail: Promise<void> = Promise.resolve();

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error
    && "code" in err
    && (err as NodeJS.ErrnoException).code === code;
}

function matchesIdentity(stats: FileIdentity, identity: FileIdentity): boolean {
  return stats.dev === identity.dev
    && stats.ino === identity.ino
    && stats.size === identity.size
    && stats.mtimeMs === identity.mtimeMs;
}

export async function readBoundedJsonFileWithIdentity(
  path: string,
  maxBytes: number,
): Promise<{ value: unknown; identity: FileIdentity } | null> {
  let handle;
  try {
    const pathStats = await lstat(path);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > maxBytes) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return null;
    const buffer = Buffer.alloc(stats.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf-8"));
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
    return {
      value,
      identity: {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      },
    };
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT") || isErrnoCode(err, "ELOOP")) return null;
    throw err;
  } finally {
    await handle?.close();
  }
}

export function projectStateRecoveryDir(homePath: string): string {
  return join(homePath, "system", "recovery", "project-state");
}

async function cleanupRecoveryDir(recoveryDir: string): Promise<void> {
  let directory;
  try {
    directory = await opendir(recoveryDir);
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }

  const retained: Array<{ path: string; mtimeMs: number }> = [];
  let visited = 0;
  for await (const entry of directory) {
    visited += 1;
    if (visited > MAX_RECOVERY_SCAN_ENTRIES) break;
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(RECOVERY_FILE_PREFIX)) continue;
    const path = join(recoveryDir, entry.name);
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      retained.push({ path, mtimeMs: stats.mtimeMs });
      if (retained.length > MAX_RECOVERY_FILES - 1) {
        retained.sort((a, b) => a.mtimeMs - b.mtimeMs);
        const oldest = retained.shift();
        if (oldest) await unlink(oldest.path);
      }
    } catch (err: unknown) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
    }
  }
}

async function preserveQuarantinedFile(quarantinePath: string, recoveryDir: string): Promise<void> {
  const previous = recoveryMutationTail;
  let release!: () => void;
  recoveryMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await mkdir(recoveryDir, { recursive: true });
    await cleanupRecoveryDir(recoveryDir);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recoveryPath = join(recoveryDir, `${RECOVERY_FILE_PREFIX}${Date.now()}-${randomUUID()}.json`);
      try {
        await link(quarantinePath, recoveryPath);
        await unlink(quarantinePath);
        return;
      } catch (err: unknown) {
        if (isErrnoCode(err, "EEXIST")) continue;
        throw err;
      }
    }
    throw new Error("Unable to preserve quarantined project state");
  } finally {
    release();
  }
}

async function restoreQuarantinedFile(
  quarantinePath: string,
  path: string,
  recoveryDir: string,
): Promise<void> {
  try {
    await link(quarantinePath, path);
    await unlink(quarantinePath);
  } catch (err: unknown) {
    if (isErrnoCode(err, "EEXIST")) {
      // A concurrently published pathname wins. Preserve the displaced file
      // in bounded Matrix-owned recovery state, never in the owner workspace.
      await preserveQuarantinedFile(quarantinePath, recoveryDir);
      return;
    }
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}

export async function removeFileIfUnchanged(
  path: string,
  identity: FileIdentity,
  options: {
    recoveryDir: string;
    /** @internal deterministic concurrency-test seams */
    onValidatedBeforeQuarantine?: () => Promise<void>;
    onRenamed?: () => Promise<void>;
    onQuarantined?: () => Promise<void>;
  },
): Promise<boolean> {
  try {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || !matchesIdentity(current, identity)) return false;
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
  await options.onValidatedBeforeQuarantine?.();

  const quarantinePath = join(dirname(path), `.${basename(path)}-${randomUUID()}.quarantine`);
  try {
    // Rename first so later validation and deletion operate on the exact inode
    // removed from the public pathname, not on a replaceable path target.
    await rename(path, quarantinePath);
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }

  try {
    await options.onRenamed?.();
    const quarantined = await lstat(quarantinePath);
    if (
      !quarantined.isFile()
      || quarantined.isSymbolicLink()
      || !matchesIdentity(quarantined, identity)
    ) {
      await restoreQuarantinedFile(quarantinePath, path, options.recoveryDir);
      return false;
    }

    await options.onQuarantined?.();
    await unlink(quarantinePath);
    return true;
  } catch (err: unknown) {
    await restoreQuarantinedFile(quarantinePath, path, options.recoveryDir);
    throw err;
  }
}
