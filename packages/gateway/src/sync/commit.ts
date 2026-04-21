import type { R2Client } from "./r2-client.js";
import { buildFileKey } from "./r2-client.js";
import {
  readManifest,
  writeManifest,
  applyCommitToManifest,
  garbageCollectTombstones,
  ManifestCapExceededError,
  type ManifestDb,
} from "./manifest.js";
import { resolveWithinPrefix } from "./path-validation.js";
import type { CommitRequest } from "./types.js";

export interface CommitDeps {
  r2: R2Client;
  db: ManifestDb;
  broadcast: (userId: string, senderPeerId: string, message: Record<string, unknown>) => void;
}

export type CommitResult =
  | { manifestVersion: number; committed: number }
  | { error: string; currentVersion: number; expectedVersion: number };

export async function handleCommit(
  deps: CommitDeps,
  userId: string,
  peerId: string,
  request: CommitRequest,
): Promise<CommitResult> {
  // Step 0: Validate all paths before acquiring lock
  for (const file of request.files) {
    const pathCheck = resolveWithinPrefix(userId, file.path);
    if (!pathCheck.valid) {
      return {
        error: "Invalid file path",
        currentVersion: 0,
        expectedVersion: request.expectedVersion,
      };
    }
  }

  const locked = await deps.db.withAdvisoryLock(userId, async (dbExecutor) => {
    const store = { r2: deps.r2, db: deps.db, dbExecutor };
    const { manifest, manifestVersion: currentVersion } = await readManifest(store, userId);

    if (request.expectedVersion !== currentVersion) {
      return {
        result: {
          error: "version_conflict",
          currentVersion,
          expectedVersion: request.expectedVersion,
        } satisfies CommitResult,
        deleteKeys: [] as string[],
        broadcastMessage: null as Record<string, unknown> | null,
      };
    }

    let updated;
    try {
      updated = applyCommitToManifest(manifest, request.files, peerId);
    } catch (err: unknown) {
      if (err instanceof ManifestCapExceededError) {
        return {
          result: {
            error: err.message,
            currentVersion,
            expectedVersion: request.expectedVersion,
          } satisfies CommitResult,
          deleteKeys: [] as string[],
          broadcastMessage: null as Record<string, unknown> | null,
        };
      }
      throw err;
    }

    const compacted = garbageCollectTombstones(updated);
    const newVersion = currentVersion + 1;
    await writeManifest(store, userId, compacted, newVersion);

    const changeFiles = request.files.map((f) => ({
      path: f.path,
      hash: f.hash,
      size: f.size,
      action: f.action ?? "update",
    }));

    const deleteKeys = request.files
      .filter((file) => file.action === "delete")
      .map((file) => buildFileKey(userId, file.path));

    // Keep stale-blob deletion inside the manifest lock. File blobs are keyed
    // by user + path, not by content hash, so deleting after releasing the
    // lock can race with another commit that re-uploads the same path.
    for (const key of deleteKeys) {
      try {
        await deps.r2.deleteObject(key);
      } catch (err: unknown) {
        console.warn(
          "[sync/commit] Failed to delete stale file blob after manifest update:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      result: {
        manifestVersion: newVersion,
        committed: request.files.length,
      } satisfies CommitResult,
      deleteKeys,
      broadcastMessage: {
        type: "sync:change",
        files: changeFiles,
        peerId,
        manifestVersion: newVersion,
      },
    };
  });

  if (locked.broadcastMessage) {
    deps.broadcast(userId, peerId, locked.broadcastMessage);
  }

  return locked.result;
}
