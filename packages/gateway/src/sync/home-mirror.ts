import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
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
import { createConflictCopyPath } from "./conflict.js";
import {
  createSerialQueue,
  hashBuffer,
  hashFileStream,
  readLocalFileForPush,
  streamToBuffer,
  waitForWatcherReady,
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
import type { SyncIgnorePatterns } from "@finnaai/matrix";
import {
  buildFileKey,
  buildStagingKey,
  type R2Client,
} from "./r2-client.js";
import type { Manifest, ManifestEntry } from "./types.js";
import type { PeerRegistry, SyncPeerConnection } from "./ws-events.js";
import { resolveSyncScope, syncScopeRegistryKey } from "./runtime-scope.js";
import { finalizeStagedObject } from "./blob-publication.js";

const RECENT_WRITE_CAP = 50_000;
const DEFAULT_MAX_PUSH_BYTES = 100 * 1024 * 1024;
const INITIAL_PUSH_CHUNK_SIZE = 50;
const LOCAL_WALK_FILE_CAP = 50_000;
const LOCAL_WALK_DEPTH_CAP = 64;

const HOME_MIRROR_TMP_SUFFIX = /\.(?:\d+|matrixos-[0-9a-f-]{36})\.tmp$/i;
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

  // `watcher` is the live local watcher; `pendingWatcher` is a replacement
  // that is still scanning during a policy rebuild. Both are closed on stop.
  let watcher: FSWatcher | null = null;
  let pendingWatcher: FSWatcher | null = null;
  let stopRequested = false;
  let subscribed = false;
  let resolvedHomeRoot = config.homeRoot;
  let userIgnorePatterns = emptyOwnerSyncIgnore();
  // Incremented by start()/stop() so queued policy refreshes from an older
  // lifecycle can never start watchers or pushes after a stop or restart.
  let lifecycleGeneration = 0;
  let watcherTaskChain: Promise<void> = Promise.resolve();
  let localWatchingEnabled = false;

  const ignored = (relPath: string): boolean =>
    isHomeMirrorIgnored(relPath, extraIgnore, userIgnorePatterns);
  const pruned = (relPath: string): boolean =>
    shouldPruneHomeMirrorPath(relPath, extraIgnore, userIgnorePatterns);
  const isCurrentLifecycle = (generation: number): boolean =>
    !stopRequested && generation === lifecycleGeneration;

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

  const store = { r2: config.r2, db: config.manifestDb };

  async function ensureWritableParent(absPath: string): Promise<void> {
    const parentDir = dirname(absPath);
    await mkdir(parentDir, { recursive: true });
    assertWithinResolvedHomeRoot(await realpath(parentDir));
  }

  async function releaseResources(): Promise<void> {
    const watchers = [watcher, pendingWatcher].filter((w): w is FSWatcher => w !== null);
    watcher = null;
    pendingWatcher = null;
    await Promise.all(watchers.map((w) => w.close()));
    if (subscribed && config.peerRegistry) {
      config.peerRegistry.removePeer(registryKey, config.peerId);
      subscribed = false;
    }
  }

  async function withManifestLock<T>(
    fn: (lockedStore: typeof store & { dbExecutor: ManifestDbExecutor }) => Promise<T>,
  ): Promise<T> {
    return config.manifestDb.withAdvisoryLock(scope, async (dbExecutor) =>
      fn({ ...store, dbExecutor }),
    );
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
      await config.r2.putObject(buildStagingKey(scope, stagingId), localFile.body);
      const { objectKey } = await finalizeStagedObject({
        r2: config.r2,
        scope,
        stagingId,
        expectedHash: localFile.hash,
        expectedSize: localFile.size,
      });

      await withManifestLock(async (lockedStore) => {
        const existing = await readManifest(lockedStore, scope);
        const currentEntry = existing.manifest.files[safeRelPath];
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
        await writeManifest(lockedStore, scope, next, newVersion);
        broadcastChange({ path: safeRelPath, hash: localFile.hash, size: localFile.size, action }, newVersion);
        log.info(`pushed ${safeRelPath} (${localFile.size}B)`);
      });
    });
  }

  async function pushDelete(relPath: string): Promise<void> {
    const safeRelPath = normalizeRelativePath(config.userId, relPath);
    const previousPolicy = safeRelPath === SYNCIGNORE_PATH
      ? await reloadUserIgnorePatterns()
      : null;
    try {
      await publishLocalDelete(safeRelPath);
    } finally {
      if (previousPolicy) await schedulePolicyRefresh(previousPolicy);
    }
  }

  async function publishLocalDelete(safeRelPath: string): Promise<void> {
    if (ignored(safeRelPath)) return;
    await enqueue(async () => {
      await withManifestLock(async (lockedStore) => {
        const existing = await readManifest(lockedStore, scope);
        const entry = existing.manifest.files[safeRelPath];
        if (!entry || entry.deleted) return;

        const next: Manifest = applyCommitToManifest(
          existing.manifest,
          [{ path: safeRelPath, hash: entry.hash, size: 0, action: "delete" }],
          config.peerId,
        );

        const newVersion = existing.manifestVersion + 1;
        await writeManifest(lockedStore, scope, next, newVersion);

        broadcastChange(
          { path: safeRelPath, hash: entry.hash, size: 0, action: "delete" },
          newVersion,
        );
        log.info(`deleted ${safeRelPath}`);
      });
    });
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
    try {
      const localStat = await lstat(absPath);
      if (localStat.isSymbolicLink()) {
        throw new Error("refusing to overwrite symlink");
      }
      if (localStat.isFile()) {
        const localHash = await hashFileStream(absPath);
        if (localHash === entry.hash) return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    let key = entry.objectKey;
    if (!key) {
      const current = await readManifest(store, scope);
      key = current.manifest.files[safeRelPath]?.objectKey
        ?? buildFileKey(scope, safeRelPath);
    }
    const obj = await config.r2.getObject(key);
    if (!obj.body) return;

    const buf = await streamToBuffer(obj.body, maxPushBytes);
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
      markWritten(safeRelPath);
      await ensureWritableParent(absPath);
      await rename(tmpPath, absPath);
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

  async function cleanupTempFiles(dir: string, relDir = "", depth = 0): Promise<void> {
    if (depth > LOCAL_WALK_DEPTH_CAP) {
      throw new Error(
        `temp file cleanup exceeded max depth of ${LOCAL_WALK_DEPTH_CAP}`,
      );
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir ? join(relDir, entry.name) : entry.name;
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (pruned(relPath)) continue;
        await cleanupTempFiles(absPath, relPath, depth + 1);
        continue;
      }
      if (entry.isFile() && HOME_MIRROR_TMP_SUFFIX.test(entry.name)) {
        try {
          await unlink(absPath);
        } catch (err: unknown) {
          if (
            !(err instanceof Error) ||
            !("code" in err) ||
            (err as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            log.error(
              `cleanup failed for orphaned temp ${relPath}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    }
  }

  async function initialPull(): Promise<void> {
    const existing = await readManifest(store, scope);
    const files = existing.manifest.files ?? {};
    let pulled = 0;
    let failed = 0;
    const remoteIgnore = files[".syncignore"];
    if (remoteIgnore?.hash && !remoteIgnore.deleted) {
      try {
        await pullFile(".syncignore", remoteIgnore);
        await reloadUserIgnorePatterns();
        pulled++;
      } catch (err: unknown) {
        log.error("pull failed for .syncignore:", errorMessage(err));
        throw new Error("initial pull incomplete: .syncignore could not be applied");
      }
    }
    for (const [relPath, entry] of Object.entries(files)) {
      if (relPath === ".syncignore") continue;
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

  async function collectLocalFiles(
    dir: string,
    relDir = "",
    files: string[] = [],
    depth = 0,
  ): Promise<string[]> {
    if (depth > LOCAL_WALK_DEPTH_CAP) {
      throw new Error(
        `local file walk exceeded max depth of ${LOCAL_WALK_DEPTH_CAP}`,
      );
    }
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relPath = relDir ? join(relDir, entry.name) : entry.name;
      const absPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Owner-ignored directories stay walkable while a negation could
        // re-include a descendant; files below are still filtered one by one.
        if (pruned(relPath)) continue;
        await collectLocalFiles(absPath, relPath, files, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isFile()) {
        if (ignored(relPath)) continue;
        files.push(relPath);
        if (files.length > LOCAL_WALK_FILE_CAP) {
          throw new Error(
            `local file walk exceeded ${LOCAL_WALK_FILE_CAP.toLocaleString()} files`,
          );
        }
      }
    }

    return files;
  }

  async function initialPush(): Promise<void> {
    const relPaths = await collectLocalFiles(config.homeRoot);
    await pushLocalPaths(relPaths, "initial push", () => !stopRequested);
  }

  async function pushLocalPaths(
    relPaths: string[],
    label: string,
    shouldContinue: () => boolean,
  ): Promise<void> {
    if (relPaths.length === 0) return;
    const snapshot = await readManifest(store, scope);
    let pushed = 0;

    for (let start = 0; start < relPaths.length; start += INITIAL_PUSH_CHUNK_SIZE) {
      if (!shouldContinue()) {
        return;
      }
      const relPathChunk = relPaths.slice(start, start + INITIAL_PUSH_CHUNK_SIZE);
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
          continue;
        }
        localFiles.push({ path: safeRelPath, file: localFile });
      }

      if (localFiles.length === 0) {
        continue;
      }

      const chunkPushed = await enqueue(async () => {
        const finalizedFiles: Array<(typeof localFiles)[number] & { objectKey: string }> = [];
        for (const local of localFiles) {
          const stagingId = randomUUID();
          await config.r2.putObject(buildStagingKey(scope, stagingId), local.file.body);
          const finalized = await finalizeStagedObject({
            r2: config.r2,
            scope,
            stagingId,
            expectedHash: local.file.hash,
            expectedSize: local.file.size,
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
          await writeManifest(lockedStore, scope, nextManifest, newVersion);
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await unlink(absPath);
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
      Number(right.path === ".syncignore") - Number(left.path === ".syncignore")
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

  // Watcher creation, policy rebuilds, and newly-included reconciliation all
  // run on this chain so at most one replacement watcher exists at a time.
  function runWatcherTask(task: () => Promise<void>): Promise<void> {
    const next = watcherTaskChain.then(task, task);
    watcherTaskChain = next.catch((err: unknown) => {
      log.error("home mirror watcher task failed:", errorMessage(err));
    });
    return next;
  }

  function onLocalEvent(kind: "push" | "delete", absPath: string): void {
    const rel = relative(config.homeRoot, absPath);
    if (wasJustWritten(rel)) return;
    if (kind === "push") {
      pushFile(rel).catch((err: unknown) => log.error(`push failed for ${rel}: ${errorMessage(err)}`));
    } else {
      pushDelete(rel).catch((err: unknown) => log.error(`delete failed for ${rel}: ${errorMessage(err)}`));
    }
  }

  // Start a watcher using the current policy and wait for its initial scan
  // so writes immediately after readiness are not missed on slow
  // filesystems. Returns null when the lifecycle ended while scanning.
  async function startLocalWatcher(generation: number): Promise<FSWatcher | null> {
    const next = watch(config.homeRoot, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
      // Directory pruning only; event handlers apply the file-level policy.
      ignored: (absPath) => pruned(relative(config.homeRoot, absPath)),
    });
    pendingWatcher = next;
    next.on("add", (absPath) => onLocalEvent("push", absPath));
    next.on("change", (absPath) => onLocalEvent("push", absPath));
    next.on("unlink", (absPath) => onLocalEvent("delete", absPath));
    next.on("error", (err: unknown) => {
      log.error(`home mirror watcher error: ${errorMessage(err)}`);
    });
    try {
      await waitForWatcherReady(next);
    } catch (err: unknown) {
      if (pendingWatcher === next) pendingWatcher = null;
      await next.close();
      throw err;
    }
    if (pendingWatcher === next) pendingWatcher = null;
    if (!isCurrentLifecycle(generation)) {
      await next.close();
      return null;
    }
    return next;
  }

  // Swap in a watcher built from the current policy. The replacement is
  // ready before the old watcher closes, so no local events fall into a gap;
  // overlapping events are idempotent because pushes compare hashes.
  async function replaceLocalWatcher(generation: number): Promise<void> {
    if (!localWatchingEnabled || !isCurrentLifecycle(generation)) return;
    const next = await startLocalWatcher(generation);
    if (!next) return;
    const previous = watcher;
    watcher = next;
    if (previous) await previous.close();
    if (!isCurrentLifecycle(generation)) return;
    config.onLocalWatcherReady?.();
  }

  // A path excluded until now may have changed on another peer meanwhile.
  // Keep the peer's committed version at the original path and publish the
  // diverged local bytes as an explicit conflict copy instead of uploading
  // them over the peer's work.
  async function preserveDivergedLocalCopy(
    safeRelPath: string,
    localBody: Buffer,
    remoteEntry: ManifestEntry,
  ): Promise<string | null> {
    const conflictRelPath = createConflictCopyPath(safeRelPath, config.peerId, new Date());
    if (ignored(conflictRelPath)) {
      log.error(`sync conflict for ${safeRelPath}: local copy kept; conflict copy path is ignored`);
      return null;
    }
    const conflictAbsPath = join(config.homeRoot, normalizeRelativePath(config.userId, conflictRelPath));
    await ensureWritableParent(conflictAbsPath);
    try {
      await writeFile(conflictAbsPath, localBody, { flag: "wx" });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        log.error(`sync conflict for ${safeRelPath}: local copy kept; conflict copy already exists`);
        return null;
      }
      throw err;
    }
    await enqueue(() => pullFile(safeRelPath, remoteEntry));
    log.error(`sync conflict for ${safeRelPath}: kept peer version, saved local copy as ${conflictRelPath}`);
    return conflictRelPath;
  }

  async function pushNewlyIncluded(
    previousPolicy: SyncIgnorePatterns,
    generation: number,
  ): Promise<void> {
    const relPaths = await collectLocalFiles(config.homeRoot);
    const snapshot = await readManifest(store, scope);
    const toPush: string[] = [];
    for (const relPath of relPaths) {
      if (!isCurrentLifecycle(generation)) return;
      if (!isHomeMirrorIgnored(relPath, extraIgnore, previousPolicy)) continue;
      const safeRelPath = normalizeRelativePath(config.userId, relPath);
      const remoteEntry = snapshot.manifest.files[safeRelPath];
      if (!remoteEntry?.hash || remoteEntry.deleted) {
        toPush.push(safeRelPath);
        continue;
      }
      const localFile = await readLocalFileForPush(join(config.homeRoot, safeRelPath), maxPushBytes);
      if (localFile.kind !== "file" || localFile.hash === remoteEntry.hash) continue;
      try {
        const conflictRelPath = await preserveDivergedLocalCopy(safeRelPath, localFile.body, remoteEntry);
        if (conflictRelPath) toPush.push(conflictRelPath);
      } catch (err: unknown) {
        log.error(`sync conflict handling failed for ${safeRelPath}:`, errorMessage(err));
      }
    }
    await pushLocalPaths(toPush, "policy refresh push", () =>
      isCurrentLifecycle(generation)
    );
  }

  // Rebuild watches and publish files the new owner policy newly includes.
  // Never rejects; failures are logged and the last watcher stays active.
  function schedulePolicyRefresh(previousPolicy: SyncIgnorePatterns): Promise<void> {
    const generation = lifecycleGeneration;
    return runWatcherTask(async () => {
      if (!isCurrentLifecycle(generation)) return;
      await replaceLocalWatcher(generation);
      if (!isCurrentLifecycle(generation)) return;
      await pushNewlyIncluded(previousPolicy, generation);
    }).catch((err: unknown) => {
      log.error("home mirror policy refresh failed:", errorMessage(err));
    });
  }

  return {
    async start(): Promise<void> {
      stopRequested = false;
      localWatchingEnabled = false;
      const generation = ++lifecycleGeneration;
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
      await reloadUserIgnorePatterns();
      if (stopRequested) return;
      await cleanupTempFiles(config.homeRoot);
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

      if (config.watchLocalChanges === false) {
        log.info(`home mirror started for ${config.homeRoot} (peer=${config.peerId})`);
        return;
      }

      localWatchingEnabled = true;
      try {
        await runWatcherTask(() => replaceLocalWatcher(generation));
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

      log.info(`home mirror started for ${config.homeRoot} (peer=${config.peerId})`);
    },

    async stop(): Promise<void> {
      stopRequested = true;
      localWatchingEnabled = false;
      lifecycleGeneration++;
      await releaseResources();
      // Let an in-flight rebuild observe the stop and close its replacement.
      await watcherTaskChain;
      await releaseResources();
      await queue.drain();
    },

    async pushLocalFile(relPath: string): Promise<void> {
      await pushFile(relPath);
    },

    async pushLocalDelete(relPath: string): Promise<void> {
      await pushDelete(relPath);
    },
  };
}
