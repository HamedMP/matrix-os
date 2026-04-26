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

  // The cache is a derivable accelerator, not a source of truth: any cached
  // state is worth losing if it would otherwise crash the daemon. A schema
  // tightening shipped in a CLI upgrade (e.g. mtime number -> int) would
  // otherwise brick every existing install until the user manually deleted
  // sync-state.json. Back the bad file up so it stays inspectable and rebuild
  // from the server manifest on next sync.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    await backupCorruptState(filePath, raw, "malformed-json", err);
    return { ...DEFAULT_STATE, files: {} };
  }

  const result = SyncStateSchema.safeParse(parsed);
  if (!result.success) {
    await backupCorruptState(filePath, raw, "schema-mismatch", result.error);
    return { ...DEFAULT_STATE, files: {} };
  }
  return result.data;
}

async function backupCorruptState(
  filePath: string,
  raw: string,
  reason: "malformed-json" | "schema-mismatch",
  cause: unknown,
): Promise<void> {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  try {
    await writeUtf8FileAtomic(backupPath, raw, 0o600);
    console.warn(
      `[manifest-cache] ${reason}: backed up ${filePath} to ${backupPath} and reset state. Cause: ${causeMessage}`,
    );
  } catch (backupErr) {
    const backupMessage =
      backupErr instanceof Error ? backupErr.message : String(backupErr);
    console.warn(
      `[manifest-cache] ${reason}: could not back up ${filePath} (${backupMessage}); resetting state anyway. Cause: ${causeMessage}`,
    );
  }
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
