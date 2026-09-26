import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
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
import { HomeMirrorState, MIRROR_STATE_DIR } from "./home-mirror-state.js";
import { HomeMirrorReconciliation } from "./home-mirror-reconciliation.js";
import { awaitMirrorOperation } from "./home-mirror-abort.js";
import { streamToBuffer } from "./home-mirror-body.js";
import { MirrorPublicationChanged, publishMirrorManifest } from "./home-mirror-publication.js";
import { createMirrorR2 } from "./home-mirror-r2.js";

const RECENT_WRITE_CAP = 50_000;
const DEFAULT_MAX_PUSH_BYTES = 100 * 1024 * 1024;
const INITIAL_PUSH_CHUNK_SIZE = 50;
const HASH_STREAM_TIMEOUT_MS = 30_000;
const LOCAL_WALK_FILE_CAP = 50_000;
const LOCAL_WALK_DEPTH_CAP = 64;

// Folders we never push -- big build outputs, transient state, secrets,
// or things that would loop on themselves (the home dir itself when run
// from inside it). Keep this conservative; the user can override with a
// `.syncignore` in their home root.
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".matrixos",
  "dist",
  "build",
  ".cache",
  ".turbo",
  "coverage",
  ".pnpm-store",
  ".vscode",
  "tmp",
  MIRROR_STATE_DIR,
]);

const DEFAULT_IGNORE_PATTERNS = [
  /\.log$/i,
  /\.tmp$/i,
  /^\.DS_Store$/,
  /\.env(\..+)?$/,
];
const DEFAULT_IGNORE_PATH_PREFIXES = [
  "data/browser-profiles",
];
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
}

export interface HomeMirror {
  start(): Promise<void>;
  stop(): Promise<void>;
  pushLocalFile(relPath: string): Promise<void>;
  pushLocalDelete(relPath: string): Promise<void>;
}

function createSerialQueue(onError: (err: unknown) => void): {
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  drain: () => Promise<void>;
} {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch((err: unknown) => {
      onError(err);
      return undefined;
    });
    return next;
  };
  return {
    enqueue,
    async drain(): Promise<void> {
      await chain;
    },
  };
}

function isIgnored(relPath: string, extraDirs?: Set<string>): boolean {
  // Treat the home root itself ("") as NOT ignored -- otherwise chokidar
  // refuses to descend into it. Only ignore actual entries.
  if (!relPath || relPath === ".") return false;
  const normalizedPath = relPath.split(sep).join("/");
  if (normalizedPath === ".matrix-version" || normalizedPath === ".template-manifest.json") return true;
  if (
    DEFAULT_IGNORE_PATH_PREFIXES.some((prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
    )
  ) {
    return true;
  }
  const segments = relPath.split(sep);
  for (const seg of segments) {
    if (DEFAULT_IGNORE_DIRS.has(seg)) return true;
    if (extraDirs?.has(seg)) return true;
  }
  const last = segments[segments.length - 1] ?? "";
  return DEFAULT_IGNORE_PATTERNS.some((p) => p.test(last));
}

function hashFileStream(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(absPath);
    const timeout = setTimeout(() => {
      s.destroy(new Error(`hash stream timed out after ${HASH_STREAM_TIMEOUT_MS}ms`));
    }, HASH_STREAM_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timeout);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => {
      cleanup();
      resolve(`sha256:${h.digest("hex")}`);
    });
    s.on("error", (err) => {
      cleanup();
      reject(err);
    });
    s.on("close", cleanup);
  });
}

function hashBuffer(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type LocalPushFile =
  | { kind: "file"; body: Buffer; hash: string; size: number }
  | { kind: "too_large"; size: number }
  | { kind: "skip" };

async function readLocalFileForPush(
  absPath: string,
  maxPushBytes: number,
): Promise<LocalPushFile> {
  let handle;
  try {
    handle = await open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      ["ENOENT", "EISDIR", "ELOOP", "ENOTDIR"].includes(
        String((err as NodeJS.ErrnoException).code),
      )
    ) {
      return { kind: "skip" };
    }
    throw err;
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      return { kind: "skip" };
    }
    if (fileStat.size > maxPushBytes) {
      return { kind: "too_large", size: fileStat.size };
    }
    const body = Buffer.from(await handle.readFile());
    return {
      kind: "file",
      body,
      hash: hashBuffer(body),
      size: body.length,
    };
  } finally {
    await handle.close();
  }
}

function normalizeRelativePath(userId: string, relPath: string): string {
  const checked = resolveWithinPrefix(userId, relPath);
  if (!checked.valid) {
    throw new Error(`invalid path: ${checked.reason}`);
  }
  return checked.key.slice(`matrixos-sync/${userId}/files/`.length);
}

// AWS SDK v3 returns its own stream type with `transformToByteArray()`,
// NOT a Web ReadableStream -- calling .getReader() throws "is not a function".

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

  let watcher: FSWatcher | null = null;
  let stopRequested = false;
  let subscribed = false;
  let resolvedHomeRoot = config.homeRoot;
  let readyForFlush = false;
  let lifecycle = new AbortController();
  let shutdownSignal: AbortSignal | undefined;
  let stopping: Promise<void> | undefined;
  let shutdownDrained = true;
  const r2 = createMirrorR2(config.r2, () => lifecycle.signal);

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
    if (subscribed && config.peerRegistry) {
      config.peerRegistry.removePeer(registryKey, config.peerId);
      subscribed = false;
    }
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
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
    if (isIgnored(safeRelPath, extraIgnore)) return;
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
    if (isIgnored(safeRelPath, extraIgnore) || localState.blocked(safeRelPath)) return;
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
    await enqueue(() => reconcileLocalDeletion(safeRelPath));
  }

  async function pullFile(relPath: string, entry: ManifestEntry): Promise<void> {
    const safeRelPath = normalizeRelativePath(config.userId, relPath);
    const absPath = join(config.homeRoot, safeRelPath);
    if (entry.size > maxPushBytes) {
      throw new Error(`remote file exceeds ${maxPushBytes} bytes`);
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
        if (isIgnored(relPath, extraIgnore)) continue;
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
    for (const [relPath, entry] of Object.entries(files)) {
      if (!entry.hash || entry.deleted || isIgnored(relPath, extraIgnore)) continue;
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
    shutdownSignal?.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      shutdownSignal?.throwIfAborted();
      const relPath = relDir ? join(relDir, entry.name) : entry.name;
      if (isIgnored(relPath, extraIgnore)) continue;
      const absPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await collectLocalFiles(absPath, relPath, files, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isFile()) {
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

  async function initialPush(shutdownDeadline?: number): Promise<void> {
    const relPaths = await collectLocalFiles(config.homeRoot);
    if (shutdownDeadline !== undefined) {
      // Only a durable prior baseline makes absence a known owner deletion.
      // pushDelete rechecks both remote hash and local absence inside the lock.
      for (const path of localState.paths()) {
        lifecycle.signal.throwIfAborted();
        if (Date.now() >= shutdownDeadline) return;
        if (!isIgnored(path, extraIgnore) && await isLocalMissing(path)) await pushDelete(path);
      }
    }
    if (relPaths.length === 0) return;
    const snapshot = await readManifest(store, scope);
    let pushed = 0;

    const chunkSize = shutdownDeadline ? 1 : INITIAL_PUSH_CHUNK_SIZE;
    for (let start = 0; start < relPaths.length; start += chunkSize) {
      if ((shutdownDeadline !== undefined && Date.now() >= shutdownDeadline) || (stopRequested && shutdownDeadline === undefined)) {
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
      log.info(`initial push: ${pushed} files`);
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
    const files = msg.files;
    for (const f of files) {
      if (!f.path || isIgnored(f.path, extraIgnore)) continue;
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
      } catch (err: unknown) {
        log.error(`remote-change failed for ${f.path}:`, errorMessage(err));
      }
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

  return {
    async start(): Promise<void> {
      if (!shutdownDrained) throw new Error("mirror shutdown incomplete");
      stopRequested = false;
      lifecycle = new AbortController();
      shutdownSignal = undefined;
      stopping = undefined;
      readyForFlush = false;
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
        readyForFlush = true;
        log.info(`home mirror started for ${config.homeRoot} (peer=${config.peerId})`);
        return;
      }

      watcher = watch(config.homeRoot, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
        ignored: (absPath) => {
          const rel = relative(config.homeRoot, absPath);
          return isIgnored(rel, extraIgnore);
        },
      });

      watcher.on("add", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushFile(rel).catch((err: unknown) => log.error(`push failed for ${rel}: ${errorMessage(err)}`));
      });
      watcher.on("change", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushFile(rel).catch((err: unknown) => log.error(`push failed for ${rel}: ${errorMessage(err)}`));
      });
      watcher.on("unlink", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushDelete(rel).catch((err: unknown) => log.error(`delete failed for ${rel}: ${errorMessage(err)}`));
      });
      watcher.on("error", (err: unknown) => {
        log.error(`home mirror watcher error: ${errorMessage(err)}`);
      });

      // Wait for chokidar to finish its initial scan and register inotify
      // watches before returning. Otherwise a write that lands immediately
      // after start() resolves can be missed on slow filesystems (notably
      // GitHub Actions runners), where the watches aren't installed yet.
      // Resolve on `close` too, so a concurrent stop() can't strand us
      // waiting for a `ready` event that will never fire on a closed watcher.
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            watcher?.off("ready", onReady);
            watcher?.off("error", onError);
            watcher?.off("close", onClose);
          };
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = (err: unknown) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          };
          const onClose = () => {
            cleanup();
            resolve();
          };
          watcher!.once("ready", onReady);
          watcher!.once("error", onError);
          watcher!.once("close", onClose);
        });
      } catch (err: unknown) {
        // Watcher errored before reaching ready -- close it (and any
        // other resources start() acquired) so we don't leak inotify
        // watches when start() throws.
        await releaseResources();
        throw err;
      }

      if (stopRequested) {
        await releaseResources();
        return;
      }

      readyForFlush = true;
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
        shutdownSignal = lifecycle.signal;
        shutdownDrained = false;
        const deadline = Date.now() + 10_000;
        const timer = setTimeout(() => lifecycle.abort(new Error("mirror shutdown deadline exceeded")), 10_000);
        try {
          const work = (async () => {
            try {
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
