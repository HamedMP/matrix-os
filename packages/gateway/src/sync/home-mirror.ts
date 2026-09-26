import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { z } from "zod/v4";
import type { SyncScope } from "@matrix-os/contracts";
import {
  applyCommitToManifest,
  readManifest,
  writeManifest,
  type ManifestDb,
  type ManifestDbExecutor,
} from "./manifest.js";
import { resolveWithinPrefix } from "./path-validation.js";
import {
  createSerialQueue,
  hashBuffer,
  hashFileStream,
  readLocalFileForPush,
  type LocalPushFile,
} from "./home-mirror-io.js";
import {
  SYNCIGNORE_MAX_BYTES,
  SYNCIGNORE_PATH,
  emptyOwnerSyncIgnore,
  isHomeMirrorIgnored,
  loadOwnerSyncIgnore,
  ownerSyncIgnoreKey,
  parseOwnerSyncIgnore,
  shouldPruneHomeMirrorPath,
} from "./home-mirror-ignore.js";
import { cleanupTempFiles, collectLocalFiles } from "./home-mirror-walk.js";
import { HomeMirrorWatcher } from "./home-mirror-watcher.js";
import type { SyncIgnorePatterns } from "@finnaai/matrix";
import {
  buildBlobKey,
  buildFileKey,
  buildStagingKey,
  type R2Client,
} from "./r2-client.js";
import type { Manifest, ManifestEntry } from "./types.js";
import type { PeerRegistry, SyncPeerConnection } from "./ws-events.js";
import { resolveSyncScope, syncScopeRegistryKey } from "./runtime-scope.js";
import { finalizeStagedObject } from "./blob-publication.js";
import { HomeMirrorState } from "./home-mirror-state.js";
import { HomeMirrorReconciliation } from "./home-mirror-reconciliation.js";
import { awaitMirrorOperation } from "./home-mirror-abort.js";
import { streamToBuffer } from "./home-mirror-body.js";
import { MirrorPublicationChanged, publishMirrorManifest } from "./home-mirror-publication.js";
import { createMirrorR2 } from "./home-mirror-r2.js";

const RECENT_WRITE_CAP = 50_000;
const DEFAULT_MAX_PUSH_BYTES = 100 * 1024 * 1024;
const INITIAL_PUSH_CHUNK_SIZE = 50;
const DEFAULT_TEMP_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_TEMP_FILE_MAX_AGE_MS = 15 * 60 * 1000;

const RemoteChangeFileSchema = z.object({
  path: z.string().min(1).max(1024),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  action: z.enum(["add", "update", "delete"]).optional(),
});
const RemoteChangeMessageSchema = z.object({
  type: z.literal("sync:change"),
  files: z.array(RemoteChangeFileSchema).max(100),
  peerId: z.string().min(1).max(128).optional(),
});

export interface HomeMirrorConfig {
  r2: R2Client;
  manifestDb: ManifestDb;
  homeRoot: string; // /home/matrixos/home
  userId: string; // handle, e.g. "alice"
  scope?: SyncScope;
  peerId: string; // gateway-internal peer id, e.g. `gateway-${handle}`
  /**
   * Peer registry to subscribe to `sync:change` broadcasts from other peers.
   * When set, the mirror registers itself as a virtual peer whose "send()"
   * handler pulls files from R2 into the container home. Omit to disable
   * the subscribe side (startup-pull-only mode).
   */
  peerRegistry?: PeerRegistry;
  logger?: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
  /** Override the path-segment match list. Used by tests. */
  extraIgnoreDirs?: Iterable<string>;
  /** Skip local auto-sync for files larger than this many bytes. */
  maxPushBytes?: number;
  /** Disable chokidar local watching while keeping explicit push/delete methods available. Used by tests and one-shot sync flows. */
  watchLocalChanges?: boolean;
  /** Interval for recurring orphaned temp-file sweeps. Defaults to 30 minutes. */
  tempCleanupIntervalMs?: number;
  /** Minimum age before a recurring sweep removes a temp file. Defaults to 15 minutes. */
  tempFileMaxAgeMs?: number;
  /** Called each time a local watcher (initial or policy rebuild) finishes its initial scan. */
  onLocalWatcherReady?: () => void;
}

export interface HomeMirror {
  start(): Promise<void>;
  stop(): Promise<void>;
  pushLocalFile(relPath: string): Promise<void>;
  pushLocalDelete(relPath: string): Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeRelativePath(userId: string, relPath: string): string {
  const checked = resolveWithinPrefix(userId, relPath);
  if (!checked.valid) {
    throw new Error(`invalid path: ${checked.reason}`);
  }
  return checked.key.slice(`matrixos-sync/${userId}/files/`.length);
}

export function createHomeMirror(config: HomeMirrorConfig): HomeMirror {
  const scope = config.scope ?? resolveSyncScope({ ownerId: config.userId });
  const registryKey = syncScopeRegistryKey(scope);
  const log = config.logger ?? {
    info: (msg, ...rest) => console.log(`[home-mirror] ${msg}`, ...rest),
    error: (msg, ...rest) => console.error(`[home-mirror] ${msg}`, ...rest),
  };
  const extraIgnore = config.extraIgnoreDirs
    ? new Set(config.extraIgnoreDirs)
    : undefined;
  const maxPushBytes = config.maxPushBytes ?? DEFAULT_MAX_PUSH_BYTES;
  const tempCleanupIntervalMs = config.tempCleanupIntervalMs ?? DEFAULT_TEMP_CLEANUP_INTERVAL_MS;
  const tempFileMaxAgeMs = config.tempFileMaxAgeMs ?? DEFAULT_TEMP_FILE_MAX_AGE_MS;

  let stopRequested = false;
  let subscribed = false;
  let resolvedHomeRoot = config.homeRoot;
  let readyForFlush = false;
  let lifecycle = new AbortController();
  let shutdownSignal: AbortSignal | undefined;
  let stopping: Promise<void> | undefined;
  let shutdownDrained = true;
  const r2 = createMirrorR2(config.r2, () => lifecycle.signal);
  let userIgnorePatterns = emptyOwnerSyncIgnore();
  // Incremented by start()/stop() so queued policy refreshes from an older
  // lifecycle can never start watchers or pushes after a stop or restart.
  let lifecycleGeneration = 0;
  let localWatchingEnabled = false;
  let tempCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let tempCleanupInFlight: Promise<void> | null = null;

  const ignored = (relPath: string): boolean =>
    isHomeMirrorIgnored(relPath, extraIgnore, userIgnorePatterns);
  const pruned = (relPath: string): boolean =>
    shouldPruneHomeMirrorPath(relPath, extraIgnore, userIgnorePatterns);
  const walkFilters = { pruned, ignored, log, signal: () => shutdownSignal };
  const isCurrentLifecycle = (generation: number): boolean =>
    !stopRequested && generation === lifecycleGeneration;
  const watchers = new HomeMirrorWatcher({
    homeRoot: config.homeRoot,
    pruned,
    onEvent: onLocalEvent,
    onError: (message) => log.error(message),
    isCurrent: isCurrentLifecycle,
    onReady: config.onLocalWatcherReady,
  });

  /** Reload owner policy from disk; returns the previous policy when it changed. */
  async function reloadUserIgnorePatterns(): Promise<SyncIgnorePatterns | null> {
    const previous = userIgnorePatterns;
    const next = await loadOwnerSyncIgnore(config.homeRoot);
    userIgnorePatterns = next;
    return ownerSyncIgnoreKey(previous) === ownerSyncIgnoreKey(next) ? null : previous;
  }

  function assertWithinResolvedHomeRoot(resolvedPath: string): void {
    if (
      resolvedPath !== resolvedHomeRoot &&
      !resolvedPath.startsWith(`${resolvedHomeRoot}${sep}`)
    ) {
      throw new Error("refusing to write through symlinked parent path");
    }
  }

  // Serial commit chain: home-mirror updates manifest in-process, but
  // multiple writes still need to read-modify-write the version counter.
  const queue = createSerialQueue((err) => {
    log.error(
      "serial queue task failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
  const enqueue = queue.enqueue;

  // Suppress watcher events for paths we just downloaded ourselves.
  // chokidar will emit `add`/`change` for files we wrote during initial
  // pull; without this guard we'd round-trip every download into an upload.
  const recentlyWritten = new Map<string, number>();
  const SUPPRESS_MS = 5_000;
  const markWritten = (relPath: string) => {
    recentlyWritten.delete(relPath);
    recentlyWritten.set(relPath, Date.now());
    // Keep enough entries to cover an initial pull of the full manifest.
    if (recentlyWritten.size > RECENT_WRITE_CAP) {
      const oldest = recentlyWritten.keys().next().value;
      if (oldest !== undefined) recentlyWritten.delete(oldest);
    }
  };
  const wasJustWritten = (relPath: string): boolean => {
    const ts = recentlyWritten.get(relPath);
    if (ts === undefined) return false;
    if (Date.now() - ts > SUPPRESS_MS) {
      recentlyWritten.delete(relPath);
      return false;
    }
    return true;
  };

  const store = { r2, db: config.manifestDb };
  const localState = new HomeMirrorState(config.homeRoot, (category) => log.error(`mirror reconciliation: ${category}`));

  const reconciliation = new HomeMirrorReconciliation(localState, async (relPath, entry) => {
    const current = entry.objectKey ? null : await readManifest(store, scope);
    const key = entry.objectKey ?? current?.manifest.files[relPath]?.objectKey ?? buildFileKey(scope, relPath);
    assertRemoteObjectKey(key, relPath, entry.hash);
    const object = await r2.getObject(key);
    if (!object.body || entry.size > maxPushBytes) throw new Error("conflict content unavailable");
    const bytes = await awaitMirrorOperation(streamToBuffer(object.body, maxPushBytes, lifecycle.signal), lifecycle.signal);
    if (bytes.length !== entry.size) throw new Error("conflict content size mismatch");
    return bytes;
  });

  function assertRemoteObjectKey(key: string, path: string, hash: string): void {
    if (key !== buildBlobKey(scope, hash) && key !== buildFileKey(scope, path)) {
      throw new Error("invalid mirror object key");
    }
  }

  async function ensureWritableParent(absPath: string): Promise<void> {
    const parentDir = dirname(absPath);
    await mkdir(parentDir, { recursive: true });
    assertWithinResolvedHomeRoot(await realpath(parentDir));
  }

  async function releaseResources(): Promise<void> {
    if (tempCleanupTimer) {
      clearInterval(tempCleanupTimer);
      tempCleanupTimer = null;
    }
    if (subscribed && config.peerRegistry) {
      config.peerRegistry.removePeer(registryKey, config.peerId);
      subscribed = false;
    }
    await watchers.close();
  }

  async function withManifestLock<T>(
    fn: (lockedStore: typeof store & { dbExecutor: ManifestDbExecutor; signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const signal = lifecycle.signal;
    return config.manifestDb.withAdvisoryLock(scope, async (dbExecutor) => {
      signal.throwIfAborted();
      return fn({ ...store, dbExecutor, signal });
    });
  }

  // Broadcast a sync:change to every registered peer EXCEPT this mirror so
  // the laptop daemon sees container edits in real-time. Without this the
  // laptop only learns about them on its own next commit (via the new
  // manifestVersion) or a full reconnect -- which breaks the "edit in
  // container, see it on laptop ~5s later" UX.
  function broadcastChange(
    file: { path: string; hash: string; size: number; action: "add" | "update" | "delete" },
    manifestVersion: number,
  ): void {
    if (!config.peerRegistry) return;
    config.peerRegistry.broadcastChange(registryKey, config.peerId, {
      type: "sync:change",
      files: [file],
      peerId: config.peerId,
      manifestVersion,
    });
  }

  function broadcastChanges(
    files: Array<{ path: string; hash: string; size: number; action: "add" | "update" | "delete" }>,
    manifestVersion: number,
  ): void {
    if (!config.peerRegistry || files.length === 0) return;
    config.peerRegistry.broadcastChange(registryKey, config.peerId, {
      type: "sync:change",
      files,
      peerId: config.peerId,
      manifestVersion,
    });
  }

  async function matchesLocal(path: string, hash: string): Promise<boolean> {
    const absPath = join(config.homeRoot, path);
    assertWithinResolvedHomeRoot(await realpath(dirname(absPath)));
    const current = await readLocalFileForPush(absPath, maxPushBytes);
    return current.kind === "file" && current.hash === hash;
  }
  async function publishCurrent(
    lockedStore: Parameters<typeof writeManifest>[0], next: Manifest, version: number,
    changes: ReadonlyArray<{ path: string; hash: string }>,
  ): Promise<boolean> {
    return publishMirrorManifest({ lockedStore, scope, next, version, changes, state: localState,
      matchesLocal, changed: () => log.info("local_changed_before_publication") });
  }

  async function pushFile(relPath: string): Promise<void> {
    const safeRelPath = normalizeRelativePath(config.userId, relPath);
    const previousPolicy = safeRelPath === SYNCIGNORE_PATH
      ? await reloadUserIgnorePatterns()
      : null;
    try {
      await publishLocalFile(safeRelPath);
    } finally {
      // Publish the policy file first, then bring watches in line with it.
      if (previousPolicy) await schedulePolicyRefresh(previousPolicy);
    }
  }

  async function publishLocalFile(safeRelPath: string): Promise<void> {
    if (ignored(safeRelPath)) return;
    const absPath = join(config.homeRoot, safeRelPath);

    await enqueue(async () => {
      const localFile = await readLocalFileForPush(absPath, maxPushBytes);
      if (localFile.kind === "skip") return;
      if (localFile.kind === "too_large") {
        log.error(
          `skipping push for ${safeRelPath}: file exceeds ${maxPushBytes} bytes`,
        );
        return;
      }

      const stagingId = randomUUID();
      await r2.putObject(buildStagingKey(scope, stagingId), localFile.body);
      const { objectKey } = await finalizeStagedObject({
        r2,
        scope,
        stagingId,
        expectedHash: localFile.hash,
        expectedSize: localFile.size,
        signal: lifecycle.signal,
      });

      await withManifestLock(async (lockedStore) => {
        const existing = await readManifest(lockedStore, scope);
        const currentEntry = existing.manifest.files[safeRelPath];
        if (!await matchesLocal(safeRelPath, localFile.hash)) return;
        if (!await reconciliation.canPublish(safeRelPath, localFile.hash, currentEntry)) return;
        if (currentEntry?.hash === localFile.hash && !currentEntry.deleted) {
          // Already in manifest with same hash -- skip the upload.
          return;
        }

        const action = currentEntry ? "update" : "add";
        const next: Manifest = applyCommitToManifest(
          existing.manifest,
          [{ path: safeRelPath, hash: localFile.hash, size: localFile.size, action, objectKey }],
          config.peerId,
        );

        const newVersion = existing.manifestVersion + 1;
        lifecycle.signal.throwIfAborted();
        if (!await publishCurrent(lockedStore, next, newVersion, [{ path: safeRelPath, hash: localFile.hash }])) return;
        await localState.remember(safeRelPath, localFile.hash);
        broadcastChange({ path: safeRelPath, hash: localFile.hash, size: localFile.size, action }, newVersion);
        log.info(`pushed ${safeRelPath} (${localFile.size}B)`);
      });
    });
  }

  async function isLocalMissing(safeRelPath: string): Promise<boolean> {
    const absPath = join(config.homeRoot, safeRelPath);
    let parent = dirname(absPath);
    for (;;) {
      try { assertWithinResolvedHomeRoot(await realpath(parent)); break; }
      catch (error: unknown) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        if (parent === config.homeRoot) throw error;
        parent = dirname(parent);
      }
    }
    try { await lstat(absPath); return false; }
    catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
  }

  /** Already queued remote changes must not enqueue behind themselves. */
  async function reconcileLocalDeletion(safeRelPath: string): Promise<void> {
    if (ignored(safeRelPath) || localState.blocked(safeRelPath)) return;
    await withManifestLock(async (lockedStore) => {
      const existing = await readManifest(lockedStore, scope);
      const entry = existing.manifest.files[safeRelPath];
      if (!entry || entry.deleted) return;
      const baseline = localState.hash(safeRelPath);
      if (!baseline || !await isLocalMissing(safeRelPath)) return;
      if (entry.hash !== baseline) {
        await reconciliation.preserveDeletion(safeRelPath, entry);
        return;
      }

      const next: Manifest = applyCommitToManifest(
        existing.manifest,
        [{ path: safeRelPath, hash: entry.hash, size: 0, action: "delete" }],
        config.peerId,
      );

      const newVersion = existing.manifestVersion + 1;
      lifecycle.signal.throwIfAborted();
      try {
        await writeManifest(lockedStore, scope, next, newVersion, async () => {
          if (!await isLocalMissing(safeRelPath)) throw new MirrorPublicationChanged();
        });
      } catch (error: unknown) { if (error instanceof MirrorPublicationChanged) return; throw error; }

      await localState.forget(safeRelPath);
      broadcastChange(
        { path: safeRelPath, hash: entry.hash, size: 0, action: "delete" },
        newVersion,
      );
      log.info(`deleted ${safeRelPath}`);
    });
  }

  async function pushDelete(relPath: string): Promise<void> {
    const safeRelPath = normalizeRelativePath(config.userId, relPath);
    const previousPolicy = safeRelPath === SYNCIGNORE_PATH
      ? await reloadUserIgnorePatterns()
      : null;
    try {
      await enqueue(() => reconcileLocalDeletion(safeRelPath));
    } finally {
      if (previousPolicy) await schedulePolicyRefresh(previousPolicy);
    }
  }

  // Remote policy content is validated before it touches disk so a rejected
  // .syncignore can never replace the last valid owner policy.
  function validateRemoteBody(safeRelPath: string, body: Buffer): void {
    if (safeRelPath === SYNCIGNORE_PATH) parseOwnerSyncIgnore(body.toString("utf8"));
  }

  async function pullFile(relPath: string, entry: ManifestEntry): Promise<void> {
    const safeRelPath = normalizeRelativePath(config.userId, relPath);
    const absPath = join(config.homeRoot, safeRelPath);
    if (entry.size > maxPushBytes) {
      throw new Error(`remote file exceeds ${maxPushBytes} bytes`);
    }
    if (safeRelPath === SYNCIGNORE_PATH && entry.size > SYNCIGNORE_MAX_BYTES) {
      throw new Error(`.syncignore exceeds ${SYNCIGNORE_MAX_BYTES} bytes`);
    }
    let expectedHash: string | null = null;
    try {
      const localStat = await lstat(absPath);
      if (localStat.isSymbolicLink()) {
        throw new Error("refusing to overwrite symlink");
      }
      if (localStat.isFile()) {
        const localHash = await hashFileStream(absPath);
        expectedHash = localHash;
        if (!await reconciliation.shouldPull(safeRelPath, localHash, entry)) return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (localState.hash(safeRelPath) !== undefined) {
        await reconcileLocalDeletion(safeRelPath);
        return;
      }
    }

    let key = entry.objectKey;
    if (!key) {
      const current = await readManifest(store, scope);
      key = current.manifest.files[safeRelPath]?.objectKey
        ?? buildFileKey(scope, safeRelPath);
    }
    assertRemoteObjectKey(key, safeRelPath, entry.hash);
    const obj = await r2.getObject(key);
    if (!obj.body) return;

    const buf = await awaitMirrorOperation(streamToBuffer(obj.body, maxPushBytes, lifecycle.signal), lifecycle.signal);
    if (buf.length !== entry.size) {
      throw new Error("downloaded blob size did not match manifest entry");
    }
    if (hashBuffer(buf) !== entry.hash) {
      throw new Error("downloaded blob hash did not match manifest entry");
    }
    validateRemoteBody(safeRelPath, buf);
    await ensureWritableParent(absPath);
    const tmpPath = `${absPath}.matrixos-${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, buf, { flag: "wx" });
      assertWithinResolvedHomeRoot(await realpath(tmpPath));
      await ensureWritableParent(absPath);
      const current = await readLocalFileForPush(absPath, maxPushBytes);
      const currentHash = current.kind === "file" ? current.hash : null;
      if (currentHash !== expectedHash) {
        await localState.preserve(safeRelPath, currentHash ?? hashBuffer(Buffer.alloc(0)), entry.hash, buf);
        await unlink(tmpPath);
        return;
      }
      lifecycle.signal.throwIfAborted();
      markWritten(safeRelPath);
      await rename(tmpPath, absPath);
      await localState.remember(safeRelPath, entry.hash);
      try {
        assertWithinResolvedHomeRoot(await realpath(absPath));
      } catch (err: unknown) {
        await unlink(absPath).catch((cleanupErr: unknown) => {
          if (
            !(cleanupErr instanceof Error) ||
            !("code" in cleanupErr) ||
            (cleanupErr as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            log.error(
              "failed to clean up escaped-path file:",
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            );
          }
        });
        throw err;
      }
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch (cleanupErr) {
        if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
          log.error(
            `cleanup failed for ${safeRelPath} temp file:`,
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          );
        }
      }
      throw err;
    }
    log.info(`pulled ${safeRelPath} (${buf.length}B)`);
  }

  async function initialPull(): Promise<void> {
    const existing = await readManifest(store, scope);
    const files = existing.manifest.files ?? {};
    let pulled = 0;
    let failed = 0;
    const remoteIgnore = files[SYNCIGNORE_PATH];
    if (remoteIgnore?.hash && !remoteIgnore.deleted) {
      try {
        await pullFile(SYNCIGNORE_PATH, remoteIgnore);
        await reloadUserIgnorePatterns();
        pulled++;
      } catch (err: unknown) {
        log.error("pull failed for .syncignore:", errorMessage(err));
        throw new Error("initial pull incomplete: .syncignore could not be applied");
      }
    }
    for (const [relPath, entry] of Object.entries(files)) {
      if (relPath === SYNCIGNORE_PATH) continue;
      if (!entry.hash || entry.deleted || ignored(relPath)) continue;
      try {
        await pullFile(relPath, entry);
        pulled++;
      } catch (err: unknown) {
        failed++;
        log.error(`pull failed for ${relPath}:`, errorMessage(err));
      }
    }
    if (failed > 0) {
      throw new Error(`initial pull incomplete: ${failed} file(s) failed`);
    }
    if (pulled > 0) log.info(`initial pull: ${pulled} files`);
  }

  async function initialPush(shutdownDeadline?: number): Promise<void> {
    const relPaths = await collectLocalFiles(config.homeRoot, walkFilters);
    if (shutdownDeadline !== undefined) {
      // Only a durable prior baseline makes absence a known owner deletion.
      // pushDelete rechecks both remote hash and local absence inside the lock.
      for (const path of localState.paths()) {
        lifecycle.signal.throwIfAborted();
        if (Date.now() >= shutdownDeadline) return;
        if (!ignored(path) && await isLocalMissing(path)) await pushDelete(path);
      }
    }
    await pushLocalPaths(
      relPaths,
      "initial push",
      shutdownDeadline ? 1 : INITIAL_PUSH_CHUNK_SIZE,
      () => shutdownDeadline !== undefined ? Date.now() < shutdownDeadline : !stopRequested,
    );
  }

  // Publish local files in chunks. Every publish goes through the manifest
  // lock and reconciliation.canPublish, so a diverged remote version or a
  // tombstone is preserved rather than overwritten or resurrected.
  async function pushLocalPaths(
    relPaths: string[],
    label: string,
    chunkSize: number,
    shouldContinue: () => boolean,
  ): Promise<void> {
    if (relPaths.length === 0) return;
    const snapshot = await readManifest(store, scope);
    let pushed = 0;

    for (let start = 0; start < relPaths.length; start += chunkSize) {
      if (!shouldContinue()) {
        return;
      }
      const relPathChunk = relPaths.slice(start, start + chunkSize);
      const localFiles: Array<{
        path: string;
        file: Extract<LocalPushFile, { kind: "file" }>;
      }> = [];

      for (const relPath of relPathChunk) {
        const safeRelPath = normalizeRelativePath(config.userId, relPath);
        const absPath = join(config.homeRoot, safeRelPath);
        const localFile = await readLocalFileForPush(absPath, maxPushBytes);
        if (localFile.kind === "skip") continue;
        if (localFile.kind === "too_large") {
          log.error(
            `skipping push for ${safeRelPath}: file exceeds ${maxPushBytes} bytes`,
          );
          continue;
        }
        const snapshotEntry = snapshot.manifest.files[safeRelPath];
        if (snapshotEntry?.hash === localFile.hash && !snapshotEntry.deleted) {
          await localState.remember(safeRelPath, localFile.hash);
          continue;
        }
        if (!localState.blocked(safeRelPath)) localFiles.push({ path: safeRelPath, file: localFile });
      }

      if (localFiles.length === 0) {
        continue;
      }

      const chunkPushed = await enqueue(async () => {
        const finalizedFiles: Array<(typeof localFiles)[number] & { objectKey: string }> = [];
        for (const local of localFiles) {
          const stagingId = randomUUID();
          await r2.putObject(buildStagingKey(scope, stagingId), local.file.body);
          const finalized = await finalizeStagedObject({
            r2,
            scope,
            stagingId,
            expectedHash: local.file.hash,
            expectedSize: local.file.size,
            signal: lifecycle.signal,
          });
          finalizedFiles.push({ ...local, objectKey: finalized.objectKey });
        }
        return withManifestLock(async (lockedStore) => {
          const existing = await readManifest(lockedStore, scope);
          let nextManifest = existing.manifest;
          const changedFiles: Array<{
            path: string;
            hash: string;
            size: number;
            action: "add" | "update";
          }> = [];
          for (const { path: safeRelPath, file: localFile, objectKey } of finalizedFiles) {
              const currentEntry = nextManifest.files[safeRelPath];
              if (!await matchesLocal(safeRelPath, localFile.hash)) continue;
              if (!await reconciliation.canPublish(safeRelPath, localFile.hash, currentEntry)) continue;
              if (currentEntry?.hash === localFile.hash && !currentEntry.deleted) {
                continue;
              }

              const action = currentEntry ? "update" as const : "add" as const;
              nextManifest = applyCommitToManifest(
                nextManifest,
                [{
                  path: safeRelPath,
                  hash: localFile.hash,
                  size: localFile.size,
                  action,
                  objectKey,
                }],
                config.peerId,
              );

              changedFiles.push({
                path: safeRelPath,
                hash: localFile.hash,
                size: localFile.size,
                action,
              });
          }

          if (changedFiles.length === 0) {
            return 0;
          }

          const newVersion = existing.manifestVersion + 1;
          lifecycle.signal.throwIfAborted();
          if (!await publishCurrent(lockedStore, nextManifest, newVersion, changedFiles)) return 0;
          for (const file of changedFiles) await localState.remember(file.path, file.hash);
          broadcastChanges(changedFiles, newVersion);
          return changedFiles.length;
        });
      });

      pushed += chunkPushed;
    }

    if (pushed > 0) {
      log.info(`${label}: ${pushed} files`);
    }
  }

  async function pullDelete(relPath: string): Promise<void> {
    const safeRelPath = normalizeRelativePath(config.userId, relPath);
    const absPath = join(config.homeRoot, safeRelPath);
    try {
      const localStat = await lstat(absPath); // throws ENOENT if already gone
      if (localStat.isSymbolicLink()) {
        log.error(`refusing to delete symlink ${safeRelPath}`);
        return;
      }
      if (localStat.isFile() && await hashFileStream(absPath) !== localState.hash(safeRelPath)) {
        log.error("mirror reconciliation: delete_conflict_preserved");
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await unlink(absPath);
    await localState.forget(safeRelPath);
    markWritten(safeRelPath);
    log.info(`pulled delete ${safeRelPath}`);
  }

  // Handle a `sync:change` broadcast from another peer. Applies to each file
  // in the message: downloads the new content (or deletes locally). The
  // recentlyWritten guard suppresses the chokidar echo so we don't push it
  // back up to R2. Errors are logged per-file; one bad file doesn't stop
  // the rest. Returns after all files have been processed.
  async function handleRemoteChange(msg: z.infer<typeof RemoteChangeMessageSchema>): Promise<void> {
    // Apply policy changes before other files in the same broadcast so a
    // freshly restored or updated .syncignore governs the whole batch.
    const files = [...msg.files].sort((left, right) =>
      Number(right.path === SYNCIGNORE_PATH) - Number(left.path === SYNCIGNORE_PATH)
    );
    let previousPolicy: SyncIgnorePatterns | null = null;
    for (const f of files) {
      if (!f.path || (f.path !== SYNCIGNORE_PATH && ignored(f.path))) continue;
      try {
        if (f.action === "delete") {
          await pullDelete(f.path);
        } else {
          await pullFile(f.path, {
            hash: f.hash,
            size: f.size,
            mtime: Date.now(),
            peerId: msg.peerId ?? "remote",
            version: 0,
          } as ManifestEntry);
        }
        if (f.path === SYNCIGNORE_PATH) {
          previousPolicy = (await reloadUserIgnorePatterns()) ?? previousPolicy;
        }
      } catch (err: unknown) {
        // A rejected policy is logged and skipped; later files in the batch
        // still apply under the last successfully loaded policy.
        log.error(`remote-change failed for ${f.path}:`, errorMessage(err));
      }
    }
    if (previousPolicy) {
      // Runs outside the serial queue: the refresh enqueues its own pushes.
      void schedulePolicyRefresh(previousPolicy);
    }
  }

  // A fake WS connection the peer registry can "send" broadcasts through.
  // readyState=1 so the registry doesn't skip us; each send() is parsed as
  // a sync event and dispatched to handleRemoteChange. Ignoring non-change
  // messages keeps us compatible with future broadcast types (peer-join etc.)
  // without blowing up on unknown `type`.
  function createSubscriberConnection(): SyncPeerConnection {
    return {
      readyState: 1,
      send(data: string) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch (err: unknown) {
          log.error(
            "ignored malformed peer broadcast:",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
        const parsedMsg = RemoteChangeMessageSchema.safeParse(parsed);
        if (!parsedMsg.success) {
          if (
            parsed &&
            typeof parsed === "object" &&
            "type" in (parsed as Record<string, unknown>) &&
            (parsed as Record<string, unknown>).type !== "sync:change"
          ) {
            return;
          }
          log.error(
            "ignored malformed peer broadcast:",
            parsedMsg.error.issues[0]?.message ?? "invalid sync:change payload",
          );
          return;
        }
        // Fire-and-forget; the registry's send is synchronous so we can't
        // await here. Errors are logged inside handleRemoteChange.
        enqueue(() => handleRemoteChange(parsedMsg.data))
          .catch((err: unknown) => log.error("remote-change enqueue failed:", errorMessage(err)));
      },
    };
  }

  // Recurring sweep for temp files orphaned after startup (e.g. a download
  // interrupted by an I/O error). Skips overlapping runs; cleared on stop.
  function scheduleTempCleanup(generation: number): void {
    if (tempCleanupTimer) clearInterval(tempCleanupTimer);
    tempCleanupTimer = setInterval(() => {
      if (tempCleanupInFlight || !isCurrentLifecycle(generation)) return;
      tempCleanupInFlight = cleanupTempFiles(config.homeRoot, walkFilters, tempFileMaxAgeMs)
        .catch((err: unknown) => log.error("temp file sweep failed:", errorMessage(err)))
        .finally(() => {
          tempCleanupInFlight = null;
        });
    }, tempCleanupIntervalMs);
    tempCleanupTimer.unref?.();
  }

  function onLocalEvent(kind: "push" | "delete", rel: string): void {
    if (wasJustWritten(rel)) return;
    if (kind === "push") {
      pushFile(rel).catch((err: unknown) => log.error(`push failed for ${rel}: ${errorMessage(err)}`));
    } else {
      pushDelete(rel).catch((err: unknown) => log.error(`delete failed for ${rel}: ${errorMessage(err)}`));
    }
  }

  async function replaceLocalWatcher(generation: number): Promise<void> {
    if (!localWatchingEnabled || !isCurrentLifecycle(generation)) return;
    await watchers.replace(generation);
  }

  // Apply peer state for paths the new owner policy newly includes, through
  // the same reconciliation as every other pull: unambiguous peer versions
  // and deletions land in the home; ambiguous divergence is recorded, not
  // resolved in either direction. Runs inside the serial queue.
  async function pullNewlyIncluded(
    previousPolicy: SyncIgnorePatterns,
    generation: number,
  ): Promise<void> {
    const { manifest } = await readManifest(store, scope);
    for (const [relPath, entry] of Object.entries(manifest.files)) {
      if (!isCurrentLifecycle(generation)) return;
      if (!entry.hash || ignored(relPath)) continue;
      if (!isHomeMirrorIgnored(relPath, extraIgnore, previousPolicy)) continue;
      try {
        if (!entry.deleted) {
          await pullFile(relPath, entry);
          continue;
        }
        const safeRelPath = normalizeRelativePath(config.userId, relPath);
        const local = await readLocalFileForPush(join(config.homeRoot, safeRelPath), maxPushBytes);
        // The peer deleted exactly the bytes held here: that version is the
        // shared baseline, so applying the deletion loses no local edit.
        if (local.kind === "file" && local.hash === entry.hash && localState.hash(safeRelPath) === undefined) {
          await localState.remember(safeRelPath, entry.hash);
        }
        await pullDelete(safeRelPath);
      } catch (err: unknown) {
        log.error(`policy refresh pull failed for ${relPath}:`, errorMessage(err));
      }
    }
  }

  // Publish files the new owner policy newly includes. They go through the
  // same locked reconciliation as every other publish, so a path that
  // diverged on another peer while excluded is preserved as a conflict.
  async function pushNewlyIncluded(
    previousPolicy: SyncIgnorePatterns,
    generation: number,
  ): Promise<void> {
    const relPaths = await collectLocalFiles(config.homeRoot, walkFilters);
    const newlyIncluded = relPaths.filter((relPath) =>
      isHomeMirrorIgnored(relPath, extraIgnore, previousPolicy)
    );
    await pushLocalPaths(newlyIncluded, "policy refresh push", INITIAL_PUSH_CHUNK_SIZE, () =>
      isCurrentLifecycle(generation)
    );
  }

  // Rebuild watches, then apply peer state and publish local files for paths
  // the new owner policy newly includes.
  // Never rejects; failures are logged and the last watcher stays active.
  function schedulePolicyRefresh(previousPolicy: SyncIgnorePatterns): Promise<void> {
    const generation = lifecycleGeneration;
    return watchers.run(async () => {
      if (!isCurrentLifecycle(generation)) return;
      await replaceLocalWatcher(generation);
      if (!isCurrentLifecycle(generation)) return;
      await enqueue(() => pullNewlyIncluded(previousPolicy, generation));
      if (!isCurrentLifecycle(generation)) return;
      await pushNewlyIncluded(previousPolicy, generation);
    }).catch((err: unknown) => {
      log.error("home mirror policy refresh failed:", errorMessage(err));
    });
  }

  return {
    async start(): Promise<void> {
      if (!shutdownDrained) throw new Error("mirror shutdown incomplete");
      stopRequested = false;
      lifecycle = new AbortController();
      shutdownSignal = undefined;
      stopping = undefined;
      readyForFlush = false;
      localWatchingEnabled = false;
      const generation = ++lifecycleGeneration;
      try {
      await mkdir(config.homeRoot, { recursive: true });
      try {
        resolvedHomeRoot = await realpath(config.homeRoot);
      } catch (err: unknown) {
        log.error(
          `failed to resolve home root ${config.homeRoot}; using configured path:`,
          errorMessage(err),
        );
        resolvedHomeRoot = config.homeRoot;
      }
      if (stopRequested) return;
      await localState.load();
      await reloadUserIgnorePatterns();
      if (stopRequested) return;
      await cleanupTempFiles(config.homeRoot, walkFilters, 0);
      if (stopRequested) return;
      await initialPull();
      if (stopRequested) return;

      // Register with the peer registry BEFORE starting the watcher. Any
      // commits that land while we're catching up will queue through
      // handleRemoteChange and run serially via `enqueue`.
      if (config.peerRegistry) {
        config.peerRegistry.registerPeer(
          registryKey,
          {
            peerId: config.peerId,
            hostname: "gateway",
            platform: "linux",
            clientVersion: "home-mirror",
          },
          createSubscriberConnection(),
        );
        subscribed = true;
        log.info(`home mirror subscribed to broadcasts as ${config.peerId}`);
      }

      if (stopRequested) {
        await releaseResources();
        return;
      }
      await initialPush();
      if (stopRequested) {
        await releaseResources();
        return;
      }

      scheduleTempCleanup(generation);

      if (config.watchLocalChanges === false) {
        readyForFlush = true;
        log.info(`home mirror started for ${config.homeRoot} (peer=${config.peerId})`);
        return;
      }

      localWatchingEnabled = true;
      try {
        await watchers.run(() => replaceLocalWatcher(generation));
      } catch (err: unknown) {
        // Watcher errored before reaching ready -- close it (and any
        // other resources start() acquired) so we don't leak inotify
        // watches when start() throws.
        await releaseResources();
        throw err;
      }

      if (!isCurrentLifecycle(generation)) {
        await releaseResources();
        return;
      }

      readyForFlush = true;
      // Reconcile edits made during the initial push before ignoreInitial watcher
      // registration. Later edits already enter the same serial publication queue.
      await initialPush();
      if (stopRequested) {
        await releaseResources();
        return;
      }

      log.info(`home mirror started for ${config.homeRoot} (peer=${config.peerId})`);
      } catch (error: unknown) {
        if (error instanceof Error && stopRequested && error === lifecycle.signal.reason) return;
        localState.close();
        await releaseResources();
        throw error;
      }
    },

    async stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        stopRequested = true;
        localWatchingEnabled = false;
        lifecycleGeneration++;
        shutdownSignal = lifecycle.signal;
        shutdownDrained = false;
        const deadline = Date.now() + 10_000;
        const timer = setTimeout(() => lifecycle.abort(new Error("mirror shutdown deadline exceeded")), 10_000);
        try {
          const work = (async () => {
            try {
              await releaseResources();
              // Let an in-flight rebuild observe the stop and close its
              // replacement, and let a running temp sweep finish.
              await watchers.idle();
              await tempCleanupInFlight;
              await releaseResources();
              await queue.drain();
              if (readyForFlush) await initialPush(deadline);
            } finally { shutdownDrained = true; }
          })();
          await awaitMirrorOperation(work, lifecycle.signal);
        } catch (error: unknown) {
          log.error("mirror reconciliation: shutdown_flush_failed", error instanceof Error ? "error" : "non-error");
        } finally {
          clearTimeout(timer);
          lifecycle.abort(new Error("mirror stopped"));
          readyForFlush = false;
          localState.close();
        }
      })();
      return stopping;
    },

    async pushLocalFile(relPath: string): Promise<void> {
      await pushFile(relPath);
    },

    async pushLocalDelete(relPath: string): Promise<void> {
      await pushDelete(relPath);
    },
  };
}
