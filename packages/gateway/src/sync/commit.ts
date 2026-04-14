import type { R2Client } from "./r2-client.js";
import { buildFileKey } from "./r2-client.js";
import {
  readManifest,
  writeManifest,
  applyCommitToManifest,
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
        error: `Invalid path: ${file.path}`,
        currentVersion: 0,
        expectedVersion: request.expectedVersion,
      };
    }
  }

  return deps.db.withAdvisoryLock(userId, async () => {
    // Step 1: Check version
    const meta = await deps.db.getManifestMeta(userId);
    const currentVersion = meta?.version ?? 0;

    if (request.expectedVersion !== currentVersion) {
      return {
        error: "version_conflict",
        currentVersion,
        expectedVersion: request.expectedVersion,
      };
    }

    // Step 2: Read current manifest from R2
    const store = { r2: deps.r2, db: deps.db };
    const { manifest } = await readManifest(store, userId);

    // Step 3: Apply changes
    let updated;
    try {
      updated = applyCommitToManifest(manifest, request.files, peerId);
    } catch (err: unknown) {
      if (err instanceof Error && /cap|limit|50/i.test(err.message)) {
        return {
          error: err.message,
          currentVersion,
          expectedVersion: request.expectedVersion,
        };
      }
      throw err;
    }

    // Step 4: Delete R2 objects for deleted files
    for (const file of request.files) {
      if (file.action === "delete") {
        const key = buildFileKey(userId, file.path);
        await deps.r2.deleteObject(key);
      }
    }

    // Step 5: Write updated manifest
    const newVersion = currentVersion + 1;
    await writeManifest(store, userId, updated, newVersion);

    // Step 6: Broadcast sync:change to other peers
    const changeFiles = request.files.map((f) => ({
      path: f.path,
      hash: f.hash,
      size: f.size,
      action: f.action ?? "update",
    }));

    deps.broadcast(userId, peerId, {
      type: "sync:change",
      files: changeFiles,
      peerId,
      manifestVersion: newVersion,
    });

    return {
      manifestVersion: newVersion,
      committed: request.files.length,
    };
  });
}
