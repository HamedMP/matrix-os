import { randomUUID } from 'node:crypto';
import { hashFile } from '../lib/hash.js';
import { generateConflictPath } from './conflict-resolver.js';
import { constants } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { resolve, sep } from 'node:path';
import { copyFile, link, mkdir, stat, unlink } from 'node:fs/promises';
import type { LocalFileState, ManifestEntry, SyncState } from './types.js';

export function resolveWithinSyncRoot(syncRoot: string, localRel: string): string {
  const root = resolve(syncRoot);
  const candidate = resolve(root, localRel);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new Error("Remote event path escapes sync root");
  }
  return candidate;
}

export const SYNC_STATE_FILE_CAP = 50_000;
export const SYNC_STATE_CONFLICT_CAP = 500;
/**
 * Sync daemon Sync conflict detection, copy paths, and remote reconciliation.
 *
 * Extracted from ./index.ts (Phase 1-A4). Pure move: no logic changes.
 */

export function capSyncStateFiles(syncState: SyncState): boolean {
  const entries = Object.entries(syncState.files);
  if (entries.length <= SYNC_STATE_FILE_CAP) {
    return false;
  }

  entries
    .sort(([, left], [, right]) => {
      if (left.localOnly === true && right.localOnly !== true) {
        return 1;
      }
      if (left.localOnly !== true && right.localOnly === true) {
        return -1;
      }
      return left.mtime - right.mtime;
    })
    .slice(0, entries.length - SYNC_STATE_FILE_CAP)
    .forEach(([path]) => {
      delete syncState.files[path];
    });

  return true;
}

export function capSyncStateConflicts(syncState: SyncState): boolean {
  const entries = Object.entries(syncState.conflicts ?? {});
  if (entries.length <= SYNC_STATE_CONFLICT_CAP) {
    return false;
  }

  syncState.conflicts ??= {};
  entries
    .sort(([, left], [, right]) => left.detectedAt - right.detectedAt)
    .slice(0, entries.length - SYNC_STATE_CONFLICT_CAP)
    .forEach(([path]) => {
      delete syncState.conflicts![path];
    });

  return true;
}

export function capLoadedSyncState(syncState: SyncState): boolean {
  const filesTrimmed = capSyncStateFiles(syncState);
  const conflictsTrimmed = capSyncStateConflicts(syncState);
  return filesTrimmed || conflictsTrimmed;
}

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function recordSyncConflict(
  syncState: SyncState,
  input: {
    path: string;
    conflictPath?: string;
    localHash: string;
    remoteHash: string;
    remotePeerId: string;
    detectedAt?: number;
  },
): void {
  syncState.conflicts ??= {};
  syncState.conflicts[input.path] = {
    path: input.path,
    ...(input.conflictPath ? { conflictPath: input.conflictPath } : {}),
    localHash: input.localHash,
    remoteHash: input.remoteHash,
    remotePeerId: input.remotePeerId,
    detectedAt: input.detectedAt ?? Date.now(),
    resolved: false,
  };
  capSyncStateConflicts(syncState);
}

function appendConflictCollisionSuffix(basePath: string, attempt: number): string {
  const ext = extname(basePath);
  const base = basePath.slice(0, basePath.length - ext.length);
  return `${base} ${attempt}${ext}`;
}

async function createConflictDownloadTempPath(syncRoot: string): Promise<string> {
  const tempDir = resolveWithinSyncRoot(
    syncRoot,
    join(".cache", "matrixos-sync-conflicts"),
  );
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  return join(tempDir, `download.matrixos-${randomUUID()}.tmp`);
}

async function linkOrCopyExclusive(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await link(sourcePath, targetPath);
    return;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw err;
    }
    if (
      !(err instanceof Error) ||
      !("code" in err) ||
      !["EXDEV", "EPERM", "ENOSYS"].includes(
        String((err as NodeJS.ErrnoException).code),
      )
    ) {
      throw err;
    }
  }

  await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
}

async function publishDownloadedConflictPath(
  syncRoot: string,
  preferredPath: string,
  tempPath: string,
): Promise<{ conflictPath: string; absolutePath: string }> {
  for (let attempt = 1; attempt <= 1_000; attempt++) {
    const conflictPath = attempt === 1
      ? preferredPath
      : appendConflictCollisionSuffix(preferredPath, attempt);
    const absolutePath = resolveWithinSyncRoot(syncRoot, conflictPath);
    try {
      await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
      await linkOrCopyExclusive(tempPath, absolutePath);
      return { conflictPath, absolutePath };
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Could not reserve a unique sync conflict path");
}

export type RemoteReconcileStatus =
  | "downloaded"
  | "already-synced"
  | "conflict-created"
  | "conflict-existing"
  | "delete-skipped-conflict"
  | "deleted-local";

interface RemoteFileReconcileInput {
  syncRoot: string;
  localRel: string;
  remotePath: string;
  remoteHash: string;
  remoteSize: number;
  remotePeerId: string;
  downloadRemote: (targetPath: string) => Promise<void>;
  toRemotePath?: (localRel: string) => string;
  date?: Date;
  onConflictCleanupError?: (err: unknown, conflictPath: string) => void;
}

export function shouldSkipWatcherUpload(
  existing: LocalFileState | undefined,
  eventHash: string,
  isUnresolvedConflictCopy = false,
): boolean {
  return (
    isUnresolvedConflictCopy ||
    existing?.localOnly === true ||
    existing?.lastSyncedHash === eventHash
  );
}

export type ConflictCopyPathIndex = Record<string, string>;

export function buildUnresolvedConflictCopyPathIndex(
  syncState: Pick<SyncState, "conflicts">,
): ConflictCopyPathIndex {
  const index = Object.create(null) as ConflictCopyPathIndex;
  for (const [parentPath, conflict] of Object.entries(syncState.conflicts ?? {})) {
    if (conflict.conflictPath && !conflict.resolved) {
      index[conflict.conflictPath] = parentPath;
    }
  }
  return index;
}

export function hasUnresolvedConflictCopyPath(
  conflictCopyPathIndex: ConflictCopyPathIndex,
  remotePath: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(conflictCopyPathIndex, remotePath);
}

export function resolveConflictCopyPath(
  syncState: SyncState,
  conflictCopyPathIndex: ConflictCopyPathIndex,
  conflictPath: string,
  resolvedAt = Date.now(),
): boolean {
  const parentPath = conflictCopyPathIndex[conflictPath];
  if (!parentPath) {
    return false;
  }

  delete conflictCopyPathIndex[conflictPath];
  const conflict = syncState.conflicts?.[parentPath];
  if (!conflict || conflict.conflictPath !== conflictPath || conflict.resolved) {
    return false;
  }

  delete conflict.conflictPath;
  conflict.resolved = true;
  conflict.resolvedAt = resolvedAt;
  return true;
}

export async function reconcileMissingConflictCopies(
  syncState: SyncState,
  options: {
    syncRoot: string;
    toLocalPath: (remotePath: string) => string | null;
    resolvedAt?: number;
  },
): Promise<boolean> {
  let changed = false;
  for (const [, conflict] of Object.entries(syncState.conflicts ?? {})) {
    if (!conflict.conflictPath || conflict.resolved) {
      continue;
    }

    const localRel = options.toLocalPath(conflict.conflictPath);
    if (!localRel) {
      continue;
    }

    try {
      await stat(resolveWithinSyncRoot(options.syncRoot, localRel));
    } catch (err: unknown) {
      if (!isENOENT(err)) {
        throw err;
      }
      delete syncState.files[conflict.conflictPath];
      delete conflict.conflictPath;
      conflict.resolved = true;
      conflict.resolvedAt = options.resolvedAt ?? Date.now();
      changed = true;
    }
  }

  for (const [remotePath, fileState] of Object.entries(syncState.files)) {
    if (fileState.localOnly !== true) {
      continue;
    }

    const localRel = options.toLocalPath(remotePath);
    if (!localRel) {
      continue;
    }

    try {
      await stat(resolveWithinSyncRoot(options.syncRoot, localRel));
    } catch (err: unknown) {
      if (!isENOENT(err)) {
        throw err;
      }
      delete syncState.files[remotePath];
      changed = true;
    }
  }

  return changed;
}

export function shouldCommitWatcherDelete(
  entry: LocalFileState | undefined,
  isUnresolvedConflictCopy = false,
): boolean {
  return Boolean(
    entry?.lastSyncedHash &&
    entry.localOnly !== true &&
    !isUnresolvedConflictCopy,
  );
}

export async function reconcileRemoteFileChange(
  syncState: SyncState,
  input: RemoteFileReconcileInput,
): Promise<{ status: RemoteReconcileStatus; conflictPath?: string }> {
  const localPath = resolveWithinSyncRoot(input.syncRoot, input.localRel);
  const cached = syncState.files[input.remotePath];

  let localHash: string | null = null;
  let localSize = 0;
  let localMtime = 0;
  try {
    const [hash, fileStat] = await Promise.all([hashFile(localPath), stat(localPath)]);
    localHash = hash;
    localSize = fileStat.size;
    localMtime = fileStat.mtimeMs;
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      throw err;
    }
  }

  const updateDownloadedState = async (
    targetPath: string,
    remotePath: string,
    options: { localOnly?: boolean } = {},
  ) => {
    const downloadedStat = await stat(targetPath);
    syncState.files[remotePath] = {
      hash: input.remoteHash,
      mtime: downloadedStat.mtimeMs,
      size: downloadedStat.size,
      lastSyncedHash: input.remoteHash,
      ...(options.localOnly ? { localOnly: true } : {}),
    };
    capSyncStateFiles(syncState);
  };

  if (!localHash) {
    await input.downloadRemote(localPath);
    await updateDownloadedState(localPath, input.remotePath);
    return { status: "downloaded" };
  }

  if (localHash === input.remoteHash) {
    syncState.files[input.remotePath] = {
      hash: input.remoteHash,
      mtime: localMtime,
      size: localSize,
      lastSyncedHash: input.remoteHash,
    };
    capSyncStateFiles(syncState);
    return { status: "already-synced" };
  }

  if (cached?.lastSyncedHash && localHash === cached.lastSyncedHash) {
    await input.downloadRemote(localPath);
    await updateDownloadedState(localPath, input.remotePath);
    return { status: "downloaded" };
  }

  const existingConflict = syncState.conflicts?.[input.remotePath];
  if (
    existingConflict?.conflictPath &&
    existingConflict.remoteHash === input.remoteHash &&
    !existingConflict.resolved
  ) {
    existingConflict.localHash = localHash;
    syncState.files[input.remotePath] = {
      hash: localHash,
      mtime: localMtime,
      size: localSize,
      lastSyncedHash: input.remoteHash,
    };
    capSyncStateFiles(syncState);
    return {
      status: "conflict-existing",
      conflictPath: existingConflict.conflictPath,
    };
  }

  const preferredConflictPath = generateConflictPath(
    input.localRel,
    input.remotePeerId,
    input.date ?? new Date(),
  );
  const conflictTempPath = await createConflictDownloadTempPath(input.syncRoot);
  let conflictPath = preferredConflictPath;
  let conflictAbsPath = resolveWithinSyncRoot(input.syncRoot, preferredConflictPath);
  let conflictRemotePath = input.toRemotePath?.(conflictPath) ?? conflictPath;
  try {
    await input.downloadRemote(conflictTempPath);
    const published = await publishDownloadedConflictPath(
      input.syncRoot,
      preferredConflictPath,
      conflictTempPath,
    );
    conflictPath = published.conflictPath;
    conflictAbsPath = published.absolutePath;
    conflictRemotePath = input.toRemotePath?.(conflictPath) ?? conflictPath;
  } finally {
    try {
      await unlink(conflictTempPath);
    } catch (cleanupErr: unknown) {
      if (!isENOENT(cleanupErr)) {
        input.onConflictCleanupError?.(cleanupErr, conflictRemotePath);
      }
    }
  }
  await updateDownloadedState(conflictAbsPath, conflictRemotePath, {
    localOnly: true,
  });
  syncState.files[input.remotePath] = {
    hash: localHash,
    mtime: localMtime,
    size: localSize,
    lastSyncedHash: input.remoteHash,
  };
  capSyncStateFiles(syncState);
  recordSyncConflict(syncState, {
    path: input.remotePath,
    conflictPath: conflictRemotePath,
    localHash,
    remoteHash: input.remoteHash,
    remotePeerId: input.remotePeerId,
    detectedAt: input.date?.getTime(),
  });

  return { status: "conflict-created", conflictPath: conflictRemotePath };
}

interface RemoteDeleteReconcileInput {
  syncRoot: string;
  localRel: string;
  remotePath: string;
  remoteHash: string;
  remotePeerId: string;
  toRemotePath?: (localRel: string) => string;
  date?: Date;
}

export async function reconcileRemoteDelete(
  syncState: SyncState,
  input: RemoteDeleteReconcileInput,
): Promise<{ status: RemoteReconcileStatus; conflictPath?: string }> {
  const localPath = resolveWithinSyncRoot(input.syncRoot, input.localRel);
  const cached = syncState.files[input.remotePath];

  let localHash: string | null = null;
  let localSize = 0;
  let localMtime = 0;
  try {
    const [hash, fileStat] = await Promise.all([hashFile(localPath), stat(localPath)]);
    localHash = hash;
    localSize = fileStat.size;
    localMtime = fileStat.mtimeMs;
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      throw err;
    }
  }

  if (!localHash) {
    delete syncState.files[input.remotePath];
    return { status: "deleted-local" };
  }

  const existingConflict = syncState.conflicts?.[input.remotePath];
  if (
    cached?.hash === localHash &&
    cached.lastSyncedHash === input.remoteHash &&
    existingConflict?.localHash === localHash &&
    existingConflict.remoteHash === input.remoteHash &&
    !existingConflict.resolved
  ) {
    syncState.files[input.remotePath] = {
      ...cached,
      hash: localHash,
      mtime: localMtime,
      size: localSize,
      lastSyncedHash: input.remoteHash,
    };
    capSyncStateFiles(syncState);
    return {
      status: "conflict-existing",
      conflictPath: syncState.conflicts?.[input.remotePath]?.conflictPath,
    };
  }

  if (cached?.lastSyncedHash && localHash === cached.lastSyncedHash) {
    try {
      await unlink(localPath);
    } catch (err: unknown) {
      if (!isENOENT(err)) {
        throw err;
      }
    }
    delete syncState.files[input.remotePath];
    return { status: "deleted-local" };
  }

  syncState.files[input.remotePath] = {
    hash: localHash,
    mtime: localMtime,
    size: localSize,
    lastSyncedHash: input.remoteHash,
  };
  capSyncStateFiles(syncState);
  recordSyncConflict(syncState, {
    path: input.remotePath,
    localHash,
    remoteHash: input.remoteHash,
    remotePeerId: input.remotePeerId,
    detectedAt: input.date?.getTime(),
  });

  return { status: "delete-skipped-conflict" };
}
