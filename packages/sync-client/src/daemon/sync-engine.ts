import type { Manifest, ManifestEntry, SyncState } from "./types.js";
import type { SyncIgnorePatterns } from "../lib/syncignore.js";
import { isIgnored } from "../lib/syncignore.js";

export interface FileChange {
  path: string;
  hash: string;
  size: number;
}

export interface ConflictEntry {
  path: string;
  localHash: string;
  remoteHash: string;
  remotePeerId: string;
}

export interface DeletionEntry {
  path: string;
}

export interface SyncWarning {
  code: "manifest_entry_soft_limit" | "manifest_entry_hard_limit";
  message: string;
  entryCount: number;
}

export interface ChangeSet {
  uploads: FileChange[];
  downloads: FileChange[];
  conflicts: ConflictEntry[];
  deletions: DeletionEntry[];
  warnings: SyncWarning[];
}

export interface PresignRequest {
  path: string;
  action: "put" | "get";
  hash?: string;
  size?: number;
}

const MAX_PRESIGN_BATCH = 100;
const MANIFEST_SOFT_LIMIT = 8_000;
const MANIFEST_HARD_LIMIT = 50_000;

export function detectChanges(
  localState: SyncState,
  remoteManifest: Manifest,
  ignorePatterns: SyncIgnorePatterns,
): ChangeSet {
  const uploads: FileChange[] = [];
  const downloads: FileChange[] = [];
  const conflicts: ConflictEntry[] = [];
  const deletions: DeletionEntry[] = [];
  const warnings: SyncWarning[] = [];

  const allPaths = new Set([
    ...Object.keys(localState.files),
    ...Object.keys(remoteManifest.files),
  ]);

  for (const path of allPaths) {
    if (isIgnored(path, ignorePatterns)) continue;

    const local = localState.files[path];
    const remote: ManifestEntry | undefined = remoteManifest.files[path];

    if (!local && remote) {
      if (remote.deleted) continue;
      downloads.push({ path, hash: remote.hash, size: remote.size });
      continue;
    }

    if (local && !remote) {
      if (local.lastSyncedHash) {
        uploads.push({ path, hash: local.hash, size: local.size });
      }
      continue;
    }

    if (!local || !remote) continue;

    if (remote.deleted) {
      const localChanged = local.lastSyncedHash
        ? local.hash !== local.lastSyncedHash
        : false;

      if (localChanged) {
        uploads.push({ path, hash: local.hash, size: local.size });
      } else {
        deletions.push({ path });
      }
      continue;
    }

    if (local.hash === remote.hash) continue;

    const lastSynced = local.lastSyncedHash;
    const localChanged = lastSynced ? local.hash !== lastSynced : false;
    const remoteChanged = lastSynced ? remote.hash !== lastSynced : true;

    if (localChanged && remoteChanged && local.hash !== remote.hash) {
      conflicts.push({
        path,
        localHash: local.hash,
        remoteHash: remote.hash,
        remotePeerId: remote.peerId,
      });
    } else if (localChanged && !remoteChanged) {
      uploads.push({ path, hash: local.hash, size: local.size });
    } else if (!localChanged && remoteChanged) {
      downloads.push({ path, hash: remote.hash, size: remote.size });
    } else {
      downloads.push({ path, hash: remote.hash, size: remote.size });
    }
  }

  const activeRemoteEntries = Object.values(remoteManifest.files).filter(
    (e) => !e.deleted,
  ).length;
  const projectedCount = activeRemoteEntries + uploads.length;

  if (projectedCount >= MANIFEST_HARD_LIMIT) {
    warnings.push({
      code: "manifest_entry_hard_limit",
      message: `Manifest has ${projectedCount} entries (hard limit: ${MANIFEST_HARD_LIMIT}). New file additions will be rejected. Update .syncignore to reduce entry count.`,
      entryCount: projectedCount,
    });
  } else if (projectedCount >= MANIFEST_SOFT_LIMIT) {
    warnings.push({
      code: "manifest_entry_soft_limit",
      message: `Manifest has ${projectedCount} entries (soft limit: ${MANIFEST_SOFT_LIMIT}). Consider updating .syncignore to reduce entry count.`,
      entryCount: projectedCount,
    });
  }

  return { uploads, downloads, conflicts, deletions, warnings };
}

export function buildPresignBatch(changes: ChangeSet): PresignRequest[] {
  const requests: PresignRequest[] = [];

  for (const upload of changes.uploads) {
    requests.push({
      path: upload.path,
      action: "put",
      hash: upload.hash,
      size: upload.size,
    });
  }
  for (const download of changes.downloads) {
    requests.push({ path: download.path, action: "get", hash: download.hash });
  }

  return requests.slice(0, MAX_PRESIGN_BATCH);
}
