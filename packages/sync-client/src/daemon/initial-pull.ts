import type { GatewayClient, PresignedUrl } from './r2-client.js';
import { AuthRejectedError, downloadFile, requestPresignedUrls } from './r2-client.js';
import type { LocalFileState, ManifestEntry, SyncState } from './types.js';
import { RemoteManifestEnvelopeSchema, type RemoteManifestEnvelope } from './types.js';
const INITIAL_PULL_PRESIGN_BATCH_SIZE = 100;
const INITIAL_PULL_CONCURRENCY = 4;
const INITIAL_PULL_PROGRESS_EVERY = 100;
import { hashFile } from '../lib/hash.js';
import { reconcileRemoteFileChange } from './conflicts.js';
/**
 * Sync daemon Initial pull orchestration.
 *
 * Extracted from ./index.ts (Phase 1-A4). Pure move: no logic changes.
 */

export function parseRemoteManifestEnvelope(body: unknown): RemoteManifestEnvelope {
  const parsed = RemoteManifestEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Invalid remote manifest response");
  }
  return parsed.data;
}

export interface InitialPullLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface InitialPullOptions {
  gatewayClient: GatewayClient;
  syncRoot: string;
  syncState: SyncState;
  remoteFiles: Record<string, ManifestEntry>;
  toLocal: (remotePath: string) => string | null;
  toRemote: (localRel: string) => string;
  logger: InitialPullLogger;
  requestPresignedUrls?: typeof requestPresignedUrls;
  reconcileRemoteFileChange?: typeof reconcileRemoteFileChange;
  downloadFile?: typeof downloadFile;
  saveSyncState: () => Promise<void>;
  refreshConflictCopyPathIndex: () => void;
  concurrency?: number;
  presignBatchSize?: number;
  progressEvery?: number;
}

export interface InitialPullResult {
  pulled: number;
  skipped: number;
  failed: number;
}

interface InitialPullFile {
  remotePath: string;
  localRel: string;
  entry: ManifestEntry;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= items.length) {
          return;
        }
        await worker(items[index]!);
      }
    },
  );
  await Promise.all(workers);
}

function chunkInitialPullFiles(
  files: InitialPullFile[],
  chunkSize: number,
): InitialPullFile[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: InitialPullFile[][] = [];
  for (let start = 0; start < files.length; start += size) {
    chunks.push(files.slice(start, start + size));
  }
  return chunks;
}

export async function runInitialPull(
  options: InitialPullOptions,
): Promise<InitialPullResult> {
  const requestPresign = options.requestPresignedUrls ?? requestPresignedUrls;
  const reconcileRemote = options.reconcileRemoteFileChange ?? reconcileRemoteFileChange;
  const downloadRemoteFile = options.downloadFile ?? downloadFile;
  const concurrency = options.concurrency ?? INITIAL_PULL_CONCURRENCY;
  const presignBatchSize = options.presignBatchSize ?? INITIAL_PULL_PRESIGN_BATCH_SIZE;
  const progressEvery = options.progressEvery ?? INITIAL_PULL_PROGRESS_EVERY;
  const result: InitialPullResult = { pulled: 0, skipped: 0, failed: 0 };
  let completed = 0;
  const filesToPull: InitialPullFile[] = [];
  const recordCompleted = () => {
    completed++;
    if (progressEvery > 0 && completed % progressEvery === 0) {
      options.logger.info(
        { completed, total: filesToPull.length, skipped: result.skipped, failed: result.failed },
        "Initial pull progress",
      );
    }
  };

  for (const [remotePath, entry] of Object.entries(options.remoteFiles)) {
    if (!entry?.hash) continue;
    const localRel = options.toLocal(remotePath);
    if (!localRel) continue;
    const cached = options.syncState.files[remotePath];
    if (cached?.lastSyncedHash === entry.hash) {
      result.skipped++;
      continue;
    }
    filesToPull.push({ remotePath, localRel, entry });
  }

  for (const batch of chunkInitialPullFiles(filesToPull, presignBatchSize)) {
    let urls: PresignedUrl[];
    try {
      urls = await requestPresign(
        options.gatewayClient,
        batch.map(({ remotePath }) => ({ path: remotePath, action: "get" as const })),
      );
    } catch (err: unknown) {
      if (err instanceof AuthRejectedError) {
        throw err;
      }
      for (const { remotePath } of batch) {
        result.failed++;
        recordCompleted();
        options.logger.error({ err, path: remotePath }, "Initial-pull failed");
      }
      continue;
    }
    const urlsByPath = new Map<string, PresignedUrl>(
      urls.map((url) => [url.path, url]),
    );

    await runWithConcurrency(batch, concurrency, async ({ remotePath, localRel, entry }) => {
      const url = urlsByPath.get(remotePath);
      if (!url) {
        result.failed++;
        recordCompleted();
        options.logger.error({ path: remotePath }, "Initial-pull presign missing");
        return;
      }

      try {
        const reconcileResult = await reconcileRemote(options.syncState, {
          syncRoot: options.syncRoot,
          localRel,
          remotePath,
          remoteHash: entry.hash,
          remoteSize: entry.size,
          remotePeerId: entry.peerId,
          toRemotePath: options.toRemote,
          onConflictCleanupError: (cleanupErr, conflictPath) => {
            options.logger.warn(
              { err: cleanupErr, path: conflictPath },
              "Failed to clean up reserved conflict path after download error",
            );
          },
          downloadRemote: (targetPath) => downloadRemoteFile(
            url.url,
            targetPath,
            entry.hash,
            {
              expectedSize: entry.size,
              maxBytes: entry.size,
            },
          ),
        });
        if (reconcileResult.status === "conflict-created") {
          options.logger.warn(
            { path: remotePath, conflictPath: reconcileResult.conflictPath },
            "Initial pull conflicted with local edits; preserved both files",
          );
        }
        options.refreshConflictCopyPathIndex();
        result.pulled++;
      } catch (err: unknown) {
        if (err instanceof AuthRejectedError) {
          throw err;
        }
        result.failed++;
        options.logger.error({ err, path: remotePath }, "Initial-pull failed");
      } finally {
        recordCompleted();
      }
    });
  }

  if (result.pulled > 0 || result.skipped > 0) {
    await options.saveSyncState();
    options.logger.info(result, "Initial pull complete");
  }

  return result;
}
