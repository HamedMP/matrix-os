import type { R2Client } from "./r2-client.js";
import { buildFileKey } from "./r2-client.js";
import {
  readManifest,
  writeManifest,
  applyCommitToManifest,
  garbageCollectTombstones,
  ManifestCapExceededError,
  type ManifestDb,
  type ManifestScope,
  normalizeManifestScope,
} from "./manifest.js";
import { syncScopeRegistryKey } from "./runtime-scope.js";
import {
  finalizeStagedObject,
  StagedObjectValidationError,
} from "./blob-publication.js";
import type { CommitRequest } from "./types.js";

export interface CommitDeps {
  signal?: AbortSignal;
  r2: R2Client;
  db: ManifestDb;
  broadcast: (userId: string, senderPeerId: string, message: Record<string, unknown>) => void;
  finalizeStagedObject?: typeof finalizeStagedObject;
}

export type CommitResult =
  | { manifestVersion: number; committed: number }
  | { error: string; currentVersion: number; expectedVersion: number };

export async function handleCommit(
  deps: CommitDeps,
  scopeInput: ManifestScope,
  peerId: string,
  request: CommitRequest,
): Promise<CommitResult> {
  // Shared budget for the entire batch, not five minutes per file. The CLI
  // allows six minutes, leaving time for bounded DB/manifest work and cleanup.
  const signal = AbortSignal.any([AbortSignal.timeout(240_000), ...(deps.signal ? [deps.signal] : [])]);
  signal.throwIfAborted();
  const scope = normalizeManifestScope(scopeInput);
  const scopeKey = syncScopeRegistryKey(scope);
  // Step 0: Validate all paths before acquiring lock
  for (const file of request.files) {
    try {
      buildFileKey(scope, file.path);
    } catch (err: unknown) {
      if (!(err instanceof Error)) throw err;
      console.warn("[sync] Invalid sync input", err.name);
      return {
        error: "Invalid file path",
        currentVersion: 0,
        expectedVersion: request.expectedVersion,
      };
    }
  }

  const finalizer = deps.finalizeStagedObject ?? finalizeStagedObject;
  const publishedFiles: Array<(typeof request.files)[number] & { objectKey?: string }> = [];
  for (const file of request.files) {
    if (file.action === "delete") {
      publishedFiles.push(file);
      continue;
    }
    if (!file.stagingId && !deps.finalizeStagedObject) {
      throw new StagedObjectValidationError("missing");
    }
    const finalized = await finalizer({
      signal,
      r2: deps.r2,
      scope,
      stagingId: file.stagingId ?? "00000000-0000-4000-8000-000000000000",
      expectedHash: file.hash,
      expectedSize: file.size,
    });
    publishedFiles.push({ ...file, objectKey: finalized.objectKey });
    signal.throwIfAborted();
  }

  const locked = await deps.db.withAdvisoryLock(scope, async (dbExecutor) => {
    signal.throwIfAborted();
    const store = { r2: deps.r2, db: deps.db, dbExecutor, signal };
    const { manifest, manifestVersion: currentVersion } = await readManifest(store, scope);
    signal.throwIfAborted();

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
      updated = applyCommitToManifest(manifest, publishedFiles, peerId);
    } catch (err: unknown) {
      if (err instanceof ManifestCapExceededError) {
        return {
          result: {
            error: "File limit exceeded",
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
    await writeManifest(store, scope, compacted, newVersion);

    const changeFiles = publishedFiles.map((f) => ({
      path: f.path,
      hash: f.hash,
      size: f.size,
      action: f.action ?? "update",
    }));

    return {
      result: {
        manifestVersion: newVersion,
        committed: request.files.length,
      } satisfies CommitResult,
      broadcastMessage: {
        type: "sync:change",
        files: changeFiles,
        peerId,
        manifestVersion: newVersion,
      },
    };
  });

  if (locked.broadcastMessage) {
    deps.broadcast(scopeKey, peerId, locked.broadcastMessage);
  }

  return locked.result;
}
