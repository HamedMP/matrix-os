import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SyncStateSchema } from "./types.js";
import type { SyncState, Manifest, ManifestEntry } from "./types.js";
import { writeUtf8FileAtomic } from "../lib/atomic-write.js";

export type { SyncState };

export type SyncActionType =
  | "upload"
  | "download"
  | "conflict"
  | "delete"
  | "delete-local";

export interface SyncAction {
  path: string;
  action: SyncActionType;
  localHash?: string;
  remoteHash?: string;
  remotePeerId?: string;
}

export interface CompareOptions {
  localDeleted?: string[];
}

const DEFAULT_STATE: SyncState = {
  manifestVersion: 0,
  lastSyncAt: 0,
  files: {},
};

export async function loadSyncState(filePath: string): Promise<SyncState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { ...DEFAULT_STATE, files: {} };
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  return SyncStateSchema.parse(parsed);
}

export async function saveSyncState(
  filePath: string,
  state: SyncState,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(filePath, JSON.stringify(state, null, 2), 0o600);
}

export function compareSyncState(
  localState: SyncState,
  remoteManifest: Manifest,
  options?: CompareOptions,
): SyncAction[] {
  const actions: SyncAction[] = [];
  const localDeleted = new Set(options?.localDeleted ?? []);
  const allPaths = new Set([
    ...Object.keys(localState.files),
    ...Object.keys(remoteManifest.files),
  ]);

  for (const path of allPaths) {
    const local = localState.files[path];
    const remote: ManifestEntry | undefined = remoteManifest.files[path];

    if (localDeleted.has(path)) {
      actions.push({ path, action: "delete" });
      continue;
    }

    if (!local && remote) {
      if (remote.deleted) {
        continue;
      }
      actions.push({
        path,
        action: "download",
        remoteHash: remote.hash,
        remotePeerId: remote.peerId,
      });
      continue;
    }

    if (local && !remote) {
      if (local.lastSyncedHash) {
        actions.push({ path, action: "upload", localHash: local.hash });
      }
      continue;
    }

    if (!local || !remote) continue;

    if (remote.deleted) {
      const localChanged = local.lastSyncedHash
        ? local.hash !== local.lastSyncedHash
        : false;

      if (localChanged) {
        actions.push({ path, action: "upload", localHash: local.hash });
      } else {
        actions.push({ path, action: "delete-local" });
      }
      continue;
    }

    if (local.hash === remote.hash) {
      continue;
    }

    const lastSynced = local.lastSyncedHash;
    const localChanged = lastSynced ? local.hash !== lastSynced : false;
    const remoteChanged = lastSynced ? remote.hash !== lastSynced : true;

    if (localChanged && remoteChanged && local.hash !== remote.hash) {
      actions.push({
        path,
        action: "conflict",
        localHash: local.hash,
        remoteHash: remote.hash,
        remotePeerId: remote.peerId,
      });
    } else if (localChanged && !remoteChanged) {
      actions.push({ path, action: "upload", localHash: local.hash });
    } else if (!localChanged && remoteChanged) {
      actions.push({
        path,
        action: "download",
        remoteHash: remote.hash,
        remotePeerId: remote.peerId,
      });
    } else if (localChanged && remoteChanged && local.hash === remote.hash) {
      continue;
    } else {
      actions.push({
        path,
        action: "download",
        remoteHash: remote.hash,
        remotePeerId: remote.peerId,
      });
    }
  }

  return actions;
}
