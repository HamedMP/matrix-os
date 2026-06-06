import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import {
  loadConfig,
  saveConfig,
  getConfigDir,
  type SyncConfig,
} from "../lib/config.js";
import {
  clearAuth,
  clearProfileAuth,
  isExpired,
  loadAuth,
  loadProfileAuth,
  type AuthData,
} from "../auth/token-store.js";
import { loadProfiles } from "../lib/profiles.js";
import { loadSyncIgnore } from "../lib/syncignore.js";
import { cleanupStaleMatrixosTempFiles } from "../lib/temp-files.js";
import { hashFile } from "../lib/hash.js";
import { loadSyncState, saveSyncState } from "./manifest-cache.js";
import { FileWatcher } from "./watcher.js";
import { SyncWsClient } from "./ws-client.js";
import { IpcServer } from "./ipc-server.js";
import { createIpcHandler } from "./ipc-handler.js";
import { createDaemonShellControlClient } from "./shell-control-client.js";
import { createRemotePrefixMapper } from "./remote-prefix.js";
import { generateConflictPath } from "./conflict-resolver.js";
import {
  requestPresignedUrls,
  uploadFile,
  downloadFile,
  commitFiles,
  fetchManifest,
  AuthRejectedError,
  VersionConflictError,
  type GatewayClient,
  type PresignedUrl,
} from "./r2-client.js";
import {
  RemoteManifestEnvelopeSchema,
  type ManifestEntry,
  type LocalFileState,
  type RemoteManifestEnvelope,
  type SyncChangeEvent,
  type SyncState,
} from "./types.js";

const configDir = getConfigDir();
const stateFile = join(configDir, "sync-state.json");
const socketPath = join(configDir, "daemon.sock");
const pidFile = join(configDir, "daemon.pid");
const SYNC_STATE_FILE_CAP = 50_000;
const SYNC_STATE_CONFLICT_CAP = 500;
const INITIAL_PULL_PRESIGN_BATCH_SIZE = 100;
const INITIAL_PULL_CONCURRENCY = 4;
const INITIAL_PULL_PROGRESS_EVERY = 100;

interface PollLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface WaitForManifestOptions {
  gatewayUrl: string;
  token: string;
  logger: PollLogger;
  // Overrides so tests can dial these down; production uses the defaults.
  timeoutMs?: number;
  intervalMs?: number;
  fetchTimeoutMs?: number;
}

/**
 * Polls `/api/sync/manifest` until the gateway reports a populated manifest
 * (manifestVersion > 0 or a non-empty `files` map), then resolves. Throws on
 * auth failure (401/403) or overall timeout. Transient 5xx and network
 * errors are logged and retried.
 *
 * Rationale: on fresh provisioning, the platform may spin up the container
 * before any file has been mirrored, so the manifest is empty for a few
 * seconds. Starting chokidar against an empty remote leads to confusing
 * "we just uploaded everything local" behavior the first time.
 */
export async function waitForManifest(
  opts: WaitForManifestOptions,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 10_000;

  const start = Date.now();
  let attempt = 0;
  // If the gateway responds but returns HTML/text (misconfigured proxy, wrong
  // host), no amount of waiting will fix it — bail after 3 consecutive
  // non-JSON responses instead of burning the full 120s timeout.
  let consecutiveNonJson = 0;

  for (;;) {
    attempt++;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Timed out waiting for your Matrix instance at ${opts.gatewayUrl}. Check https://app.matrix-os.com that your container is running, then restart the daemon.`,
      );
    }

    // Clamp the per-request timeout to whatever's left of the overall
    // deadline. Without this, a fetch kicked off at t=119s can push the
    // total wait to ~129s (per-request 10s on top of the 120s budget).
    const remaining = timeoutMs - elapsed;
    const perRequestTimeout = Math.min(fetchTimeoutMs, remaining);

    let res: Response;
    try {
      res = await fetch(`${opts.gatewayUrl}/api/sync/manifest`, {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(perRequestTimeout),
      });
    } catch (err: unknown) {
      // Don't propagate the underlying error message — fetch can surface raw
      // server response bytes (HTML, binary) in parse errors, which violates
      // CLAUDE.md § Error Handling. Log a generic message instead.
      if (!(err instanceof Error)) {
        opts.logger.warn(
          `Manifest poll attempt ${attempt} failed (unexpected non-Error talking to ${opts.gatewayUrl})`,
        );
      } else {
        opts.logger.warn(
          `Manifest poll attempt ${attempt} failed (network error talking to ${opts.gatewayUrl})`,
        );
      }
      await sleep(intervalMs);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error("Auth token rejected. Re-run `matrix login`.");
    }

    if (res.status >= 500) {
      opts.logger.warn(
        `Manifest poll attempt ${attempt}: ${opts.gatewayUrl} returned ${res.status}; retrying`,
      );
      await sleep(intervalMs);
      continue;
    }

    if (!res.ok) {
      // 4xx other than auth — surface so ops notice instead of looping forever.
      throw new Error(`Manifest fetch from ${opts.gatewayUrl} failed: ${res.status}`);
    }

    // Guard against gateways that return HTML (misconfigured reverse proxy,
    // captive portal, wrong host) before we feed bytes into res.json(). This
    // keeps the catch-path from ever receiving a SyntaxError whose message
    // could leak response bytes.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      consecutiveNonJson++;
      opts.logger.warn(
        `Manifest poll attempt ${attempt}: ${opts.gatewayUrl} returned non-JSON response (content-type: ${contentType || "(none)"})`,
      );
      if (consecutiveNonJson >= 3) {
        throw new Error(
          `Gateway at ${opts.gatewayUrl} keeps returning non-JSON responses. This usually means the URL is wrong or a reverse proxy is misconfigured. Fix the gateway URL and restart the daemon.`,
        );
      }
      await sleep(intervalMs);
      continue;
    }

    let body: {
      manifestVersion?: number;
      manifest?: { files?: Record<string, unknown> };
      files?: Record<string, unknown>;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        throw err;
      }
      // Shouldn't normally hit this path after the Content-Type guard above,
      // but a gateway can still lie about the header. Treat the same way —
      // generic message, bump the counter, hard-fail at 3 strikes.
      consecutiveNonJson++;
      opts.logger.warn(
        `Manifest poll attempt ${attempt}: ${opts.gatewayUrl} returned malformed JSON despite application/json header`,
      );
      if (consecutiveNonJson >= 3) {
        throw new Error(
          `Gateway at ${opts.gatewayUrl} keeps returning malformed JSON. Fix the gateway and restart the daemon.`,
        );
      }
      await sleep(intervalMs);
      continue;
    }

    consecutiveNonJson = 0;
    const version = typeof body.manifestVersion === "number" ? body.manifestVersion : 0;
    const files = body.manifest?.files ?? body.files ?? {};
    const fileCount = Object.keys(files).length;

    if (version > 0 || fileCount > 0) {
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - start) / 1000);
    opts.logger.info(`Waiting for your Matrix instance... (${elapsedSeconds}s)`);
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSerialTaskQueue(
  onError: (err: unknown) => void,
): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch((err: unknown) => {
      onError(err);
      return undefined;
    });
    return next;
  };
}

export function resolveWithinSyncRoot(syncRoot: string, localRel: string): string {
  const root = resolve(syncRoot);
  const candidate = resolve(root, localRel);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new Error("Remote event path escapes sync root");
  }
  return candidate;
}

export async function persistPauseState(
  config: SyncConfig,
  paused: boolean,
  path?: string,
): Promise<void> {
  config.pauseSync = paused;
  await saveConfig(config, path);
}

export async function writePidFileExclusive(filePath: string, pid: number): Promise<void> {
  const writeExclusive = async () => {
    await writeFile(filePath, String(pid), { flag: "wx" });
  };

  try {
    await writeExclusive();
    return;
  } catch (err: unknown) {
    if (
      !(err instanceof Error) ||
      !("code" in err) ||
      (err as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw err;
    }
  }

  let existingPid: number | null = null;
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = Number.parseInt(raw.trim(), 10);
    existingPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      await writeExclusive();
      return;
    }
    throw err;
  }

  if (existingPid !== null) {
    try {
      process.kill(existingPid, 0);
      throw new Error(`Sync daemon already running (pid ${existingPid})`);
    } catch (err: unknown) {
      if (
        !(err instanceof Error) ||
        !("code" in err) ||
        (err as NodeJS.ErrnoException).code !== "ESRCH"
      ) {
        throw err;
      }
    }
  }

  await unlink(filePath).catch((err: unknown) => {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  });
  await writeExclusive();
}

export async function adoptRemoteManifestVersion(
  syncState: SyncState,
  err: unknown,
  persist: () => Promise<void>,
): Promise<boolean> {
  if (!(err instanceof VersionConflictError)) {
    return false;
  }
  if (err.currentVersion > syncState.manifestVersion) {
    syncState.manifestVersion = err.currentVersion;
    await persist();
  }
  return true;
}

export async function adoptSyncChangeManifestVersion(
  syncState: SyncState,
  event: Pick<SyncChangeEvent, "manifestVersion">,
  shouldAdvance: boolean,
  persist: () => Promise<void>,
): Promise<boolean> {
  if (event.manifestVersion === undefined || !shouldAdvance) {
    return false;
  }
  syncState.manifestVersion = Math.max(
    syncState.manifestVersion,
    event.manifestVersion,
  );
  await persist();
  return true;
}

export function capSyncStateFiles(syncState: SyncState): boolean {
  const entries = Object.entries(syncState.files);
  if (entries.length <= SYNC_STATE_FILE_CAP) {
    return false;
  }

  entries
    .sort(([, left], [, right]) => {
      if (left.localOnly === true && right.localOnly !== true) {
        return 1;
      }
      if (left.localOnly !== true && right.localOnly === true) {
        return -1;
      }
      return left.mtime - right.mtime;
    })
    .slice(0, entries.length - SYNC_STATE_FILE_CAP)
    .forEach(([path]) => {
      delete syncState.files[path];
    });

  return true;
}

export function capSyncStateConflicts(syncState: SyncState): boolean {
  const entries = Object.entries(syncState.conflicts ?? {});
  if (entries.length <= SYNC_STATE_CONFLICT_CAP) {
    return false;
  }

  syncState.conflicts ??= {};
  entries
    .sort(([, left], [, right]) => left.detectedAt - right.detectedAt)
    .slice(0, entries.length - SYNC_STATE_CONFLICT_CAP)
    .forEach(([path]) => {
      delete syncState.conflicts![path];
    });

  return true;
}

export function capLoadedSyncState(syncState: SyncState): boolean {
  const filesTrimmed = capSyncStateFiles(syncState);
  const conflictsTrimmed = capSyncStateConflicts(syncState);
  return filesTrimmed || conflictsTrimmed;
}

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function recordSyncConflict(
  syncState: SyncState,
  input: {
    path: string;
    conflictPath?: string;
    localHash: string;
    remoteHash: string;
    remotePeerId: string;
    detectedAt?: number;
  },
): void {
  syncState.conflicts ??= {};
  syncState.conflicts[input.path] = {
    path: input.path,
    ...(input.conflictPath ? { conflictPath: input.conflictPath } : {}),
    localHash: input.localHash,
    remoteHash: input.remoteHash,
    remotePeerId: input.remotePeerId,
    detectedAt: input.detectedAt ?? Date.now(),
    resolved: false,
  };
  capSyncStateConflicts(syncState);
}

function appendConflictCollisionSuffix(basePath: string, attempt: number): string {
  const ext = extname(basePath);
  const base = basePath.slice(0, basePath.length - ext.length);
  return `${base} ${attempt}${ext}`;
}

async function createConflictDownloadTempPath(syncRoot: string): Promise<string> {
  const tempDir = resolveWithinSyncRoot(
    syncRoot,
    join(".cache", "matrixos-sync-conflicts"),
  );
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  return join(tempDir, `download.matrixos-${randomUUID()}.tmp`);
}

async function linkOrCopyExclusive(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await link(sourcePath, targetPath);
    return;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw err;
    }
    if (
      !(err instanceof Error) ||
      !("code" in err) ||
      !["EXDEV", "EPERM", "ENOSYS"].includes(
        String((err as NodeJS.ErrnoException).code),
      )
    ) {
      throw err;
    }
  }

  await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
}

async function publishDownloadedConflictPath(
  syncRoot: string,
  preferredPath: string,
  tempPath: string,
): Promise<{ conflictPath: string; absolutePath: string }> {
  for (let attempt = 1; attempt <= 1_000; attempt++) {
    const conflictPath = attempt === 1
      ? preferredPath
      : appendConflictCollisionSuffix(preferredPath, attempt);
    const absolutePath = resolveWithinSyncRoot(syncRoot, conflictPath);
    try {
      await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
      await linkOrCopyExclusive(tempPath, absolutePath);
      return { conflictPath, absolutePath };
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Could not reserve a unique sync conflict path");
}

export type RemoteReconcileStatus =
  | "downloaded"
  | "already-synced"
  | "conflict-created"
  | "conflict-existing"
  | "delete-skipped-conflict"
  | "deleted-local";

interface RemoteFileReconcileInput {
  syncRoot: string;
  localRel: string;
  remotePath: string;
  remoteHash: string;
  remoteSize: number;
  remotePeerId: string;
  downloadRemote: (targetPath: string) => Promise<void>;
  toRemotePath?: (localRel: string) => string;
  date?: Date;
  onConflictCleanupError?: (err: unknown, conflictPath: string) => void;
}

export function shouldSkipWatcherUpload(
  existing: LocalFileState | undefined,
  eventHash: string,
  isUnresolvedConflictCopy = false,
): boolean {
  return (
    isUnresolvedConflictCopy ||
    existing?.localOnly === true ||
    existing?.lastSyncedHash === eventHash
  );
}

export type ConflictCopyPathIndex = Record<string, string>;

export function buildUnresolvedConflictCopyPathIndex(
  syncState: Pick<SyncState, "conflicts">,
): ConflictCopyPathIndex {
  const index = Object.create(null) as ConflictCopyPathIndex;
  for (const [parentPath, conflict] of Object.entries(syncState.conflicts ?? {})) {
    if (conflict.conflictPath && !conflict.resolved) {
      index[conflict.conflictPath] = parentPath;
    }
  }
  return index;
}

export function hasUnresolvedConflictCopyPath(
  conflictCopyPathIndex: ConflictCopyPathIndex,
  remotePath: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(conflictCopyPathIndex, remotePath);
}

export function resolveConflictCopyPath(
  syncState: SyncState,
  conflictCopyPathIndex: ConflictCopyPathIndex,
  conflictPath: string,
  resolvedAt = Date.now(),
): boolean {
  const parentPath = conflictCopyPathIndex[conflictPath];
  if (!parentPath) {
    return false;
  }

  delete conflictCopyPathIndex[conflictPath];
  const conflict = syncState.conflicts?.[parentPath];
  if (!conflict || conflict.conflictPath !== conflictPath || conflict.resolved) {
    return false;
  }

  delete conflict.conflictPath;
  conflict.resolved = true;
  conflict.resolvedAt = resolvedAt;
  return true;
}

export async function reconcileMissingConflictCopies(
  syncState: SyncState,
  options: {
    syncRoot: string;
    toLocalPath: (remotePath: string) => string | null;
    resolvedAt?: number;
  },
): Promise<boolean> {
  let changed = false;
  for (const [, conflict] of Object.entries(syncState.conflicts ?? {})) {
    if (!conflict.conflictPath || conflict.resolved) {
      continue;
    }

    const localRel = options.toLocalPath(conflict.conflictPath);
    if (!localRel) {
      continue;
    }

    try {
      await stat(resolveWithinSyncRoot(options.syncRoot, localRel));
    } catch (err: unknown) {
      if (!isENOENT(err)) {
        throw err;
      }
      delete syncState.files[conflict.conflictPath];
      delete conflict.conflictPath;
      conflict.resolved = true;
      conflict.resolvedAt = options.resolvedAt ?? Date.now();
      changed = true;
    }
  }

  for (const [remotePath, fileState] of Object.entries(syncState.files)) {
    if (fileState.localOnly !== true) {
      continue;
    }

    const localRel = options.toLocalPath(remotePath);
    if (!localRel) {
      continue;
    }

    try {
      await stat(resolveWithinSyncRoot(options.syncRoot, localRel));
    } catch (err: unknown) {
      if (!isENOENT(err)) {
        throw err;
      }
      delete syncState.files[remotePath];
      changed = true;
    }
  }

  return changed;
}

export function shouldCommitWatcherDelete(
  entry: LocalFileState | undefined,
  isUnresolvedConflictCopy = false,
): boolean {
  return Boolean(
    entry?.lastSyncedHash &&
    entry.localOnly !== true &&
    !isUnresolvedConflictCopy,
  );
}

export async function reconcileRemoteFileChange(
  syncState: SyncState,
  input: RemoteFileReconcileInput,
): Promise<{ status: RemoteReconcileStatus; conflictPath?: string }> {
  const localPath = resolveWithinSyncRoot(input.syncRoot, input.localRel);
  const cached = syncState.files[input.remotePath];

  let localHash: string | null = null;
  let localSize = 0;
  let localMtime = 0;
  try {
    const [hash, fileStat] = await Promise.all([hashFile(localPath), stat(localPath)]);
    localHash = hash;
    localSize = fileStat.size;
    localMtime = fileStat.mtimeMs;
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      throw err;
    }
  }

  const updateDownloadedState = async (
    targetPath: string,
    remotePath: string,
    options: { localOnly?: boolean } = {},
  ) => {
    const downloadedStat = await stat(targetPath);
    syncState.files[remotePath] = {
      hash: input.remoteHash,
      mtime: downloadedStat.mtimeMs,
      size: downloadedStat.size,
      lastSyncedHash: input.remoteHash,
      ...(options.localOnly ? { localOnly: true } : {}),
    };
    capSyncStateFiles(syncState);
  };

  if (!localHash) {
    await input.downloadRemote(localPath);
    await updateDownloadedState(localPath, input.remotePath);
    return { status: "downloaded" };
  }

  if (localHash === input.remoteHash) {
    syncState.files[input.remotePath] = {
      hash: input.remoteHash,
      mtime: localMtime,
      size: localSize,
      lastSyncedHash: input.remoteHash,
    };
    capSyncStateFiles(syncState);
    return { status: "already-synced" };
  }

  if (cached?.lastSyncedHash && localHash === cached.lastSyncedHash) {
    await input.downloadRemote(localPath);
    await updateDownloadedState(localPath, input.remotePath);
    return { status: "downloaded" };
  }

  const existingConflict = syncState.conflicts?.[input.remotePath];
  if (
    existingConflict?.conflictPath &&
    existingConflict.remoteHash === input.remoteHash &&
    !existingConflict.resolved
  ) {
    existingConflict.localHash = localHash;
    syncState.files[input.remotePath] = {
      hash: localHash,
      mtime: localMtime,
      size: localSize,
      lastSyncedHash: input.remoteHash,
    };
    capSyncStateFiles(syncState);
    return {
      status: "conflict-existing",
      conflictPath: existingConflict.conflictPath,
    };
  }

  const preferredConflictPath = generateConflictPath(
    input.localRel,
    input.remotePeerId,
    input.date ?? new Date(),
  );
  const conflictTempPath = await createConflictDownloadTempPath(input.syncRoot);
  let conflictPath = preferredConflictPath;
  let conflictAbsPath = resolveWithinSyncRoot(input.syncRoot, preferredConflictPath);
  let conflictRemotePath = input.toRemotePath?.(conflictPath) ?? conflictPath;
  try {
    await input.downloadRemote(conflictTempPath);
    const published = await publishDownloadedConflictPath(
      input.syncRoot,
      preferredConflictPath,
      conflictTempPath,
    );
    conflictPath = published.conflictPath;
    conflictAbsPath = published.absolutePath;
    conflictRemotePath = input.toRemotePath?.(conflictPath) ?? conflictPath;
  } finally {
    try {
      await unlink(conflictTempPath);
    } catch (cleanupErr: unknown) {
      if (!isENOENT(cleanupErr)) {
        input.onConflictCleanupError?.(cleanupErr, conflictRemotePath);
      }
    }
  }
  await updateDownloadedState(conflictAbsPath, conflictRemotePath, {
    localOnly: true,
  });
  syncState.files[input.remotePath] = {
    hash: localHash,
    mtime: localMtime,
    size: localSize,
    lastSyncedHash: input.remoteHash,
  };
  capSyncStateFiles(syncState);
  recordSyncConflict(syncState, {
    path: input.remotePath,
    conflictPath: conflictRemotePath,
    localHash,
    remoteHash: input.remoteHash,
    remotePeerId: input.remotePeerId,
    detectedAt: input.date?.getTime(),
  });

  return { status: "conflict-created", conflictPath: conflictRemotePath };
}

interface RemoteDeleteReconcileInput {
  syncRoot: string;
  localRel: string;
  remotePath: string;
  remoteHash: string;
  remotePeerId: string;
  toRemotePath?: (localRel: string) => string;
  date?: Date;
}

export async function reconcileRemoteDelete(
  syncState: SyncState,
  input: RemoteDeleteReconcileInput,
): Promise<{ status: RemoteReconcileStatus; conflictPath?: string }> {
  const localPath = resolveWithinSyncRoot(input.syncRoot, input.localRel);
  const cached = syncState.files[input.remotePath];

  let localHash: string | null = null;
  let localSize = 0;
  let localMtime = 0;
  try {
    const [hash, fileStat] = await Promise.all([hashFile(localPath), stat(localPath)]);
    localHash = hash;
    localSize = fileStat.size;
    localMtime = fileStat.mtimeMs;
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      throw err;
    }
  }

  if (!localHash) {
    delete syncState.files[input.remotePath];
    return { status: "deleted-local" };
  }

  const existingConflict = syncState.conflicts?.[input.remotePath];
  if (
    cached?.hash === localHash &&
    cached.lastSyncedHash === input.remoteHash &&
    existingConflict?.localHash === localHash &&
    existingConflict.remoteHash === input.remoteHash &&
    !existingConflict.resolved
  ) {
    syncState.files[input.remotePath] = {
      ...cached,
      hash: localHash,
      mtime: localMtime,
      size: localSize,
      lastSyncedHash: input.remoteHash,
    };
    capSyncStateFiles(syncState);
    return {
      status: "conflict-existing",
      conflictPath: syncState.conflicts?.[input.remotePath]?.conflictPath,
    };
  }

  if (cached?.lastSyncedHash && localHash === cached.lastSyncedHash) {
    try {
      await unlink(localPath);
    } catch (err: unknown) {
      if (!isENOENT(err)) {
        throw err;
      }
    }
    delete syncState.files[input.remotePath];
    return { status: "deleted-local" };
  }

  syncState.files[input.remotePath] = {
    hash: localHash,
    mtime: localMtime,
    size: localSize,
    lastSyncedHash: input.remoteHash,
  };
  capSyncStateFiles(syncState);
  recordSyncConflict(syncState, {
    path: input.remotePath,
    localHash,
    remoteHash: input.remoteHash,
    remotePeerId: input.remotePeerId,
    detectedAt: input.date?.getTime(),
  });

  return { status: "delete-skipped-conflict" };
}

export function exitOnAuthFailure(
  err: unknown,
  logger: { error: (msg: string) => void },
  exit: (code: number) => void = process.exit,
): boolean {
  if (!(err instanceof AuthRejectedError)) {
    return false;
  }
  logger.error("Auth token rejected or expired. Re-run `matrixos login`.");
  exit(1);
  return true;
}

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

export interface DaemonAuthResolution {
  auth: AuthData | null;
  profileName: string;
  source: "profile" | "legacy" | "none";
}

export interface DaemonAuthFileAccessors {
  loadAuth: () => Promise<AuthData | null>;
  clearAuth: () => Promise<void>;
}

export function createDaemonAuthFileAccessors(
  resolution: Pick<DaemonAuthResolution, "profileName" | "source">,
  authConfigDir = configDir,
): DaemonAuthFileAccessors {
  if (resolution.source === "legacy") {
    const legacyAuthPath = join(authConfigDir, "auth.json");
    return {
      loadAuth: () => loadAuth(legacyAuthPath),
      clearAuth: () => clearAuth(legacyAuthPath),
    };
  }

  return {
    loadAuth: () => loadProfileAuth(resolution.profileName, authConfigDir),
    clearAuth: () => clearProfileAuth(resolution.profileName, authConfigDir),
  };
}

export async function resolveDaemonAuth(
  config: Pick<SyncConfig, "profile">,
  authConfigDir = configDir,
): Promise<DaemonAuthResolution> {
  let profileName = config.profile;
  if (!profileName) {
    const profiles = await loadProfiles({
      configDir: authConfigDir,
      migrateLegacyFiles: false,
    });
    profileName = profiles.active;
  }
  const profileAuth = await loadProfileAuth(profileName, authConfigDir);
  if (profileAuth) {
    return { auth: profileAuth, profileName, source: "profile" };
  }

  const legacyAuth = await loadAuth(join(authConfigDir, "auth.json"));
  if (legacyAuth) {
    return { auth: legacyAuth, profileName, source: "legacy" };
  }

  return { auth: null, profileName, source: "none" };
}

export async function startDaemon(): Promise<void> {
  await mkdir(join(configDir, "logs"), { recursive: true, mode: 0o700 });
  const logger = pino({
    transport: {
      target: "pino/file",
      options: { destination: join(configDir, "logs", "sync.log") },
    },
  });

  const config = await loadConfig();
  if (!config) {
    logger.error("No config found. Run 'matrixos sync <path>' first.");
    process.exit(1);
  }

  const { auth, profileName, source } = await resolveDaemonAuth(config);
  if (!auth) {
    logger.error(`Not logged in for profile "${profileName}". Run 'matrixos login' first.`);
    process.exit(1);
  }
  if (isExpired(auth)) {
    logger.error("Auth token rejected or expired. Re-run `matrixos login`.");
    process.exit(1);
  }

  try {
    await writePidFileExclusive(pidFile, process.pid);
  } catch (err) {
    logger.error({ err }, "Could not acquire daemon pid file");
    process.exit(1);
  }

  for (const root of [configDir, config.syncPath]) {
    try {
      await cleanupStaleMatrixosTempFiles(root, {
        olderThanMs: 60_000,
        logger: {
          warn: (msg, err) => {
            if (err) {
              logger.warn({ err }, msg);
              return;
            }
            logger.warn(msg);
          },
        },
      });
    } catch (err) {
      logger.warn({ err, root }, "Temp file cleanup failed");
    }
  }

  const ignorePatterns = await loadSyncIgnore(config.syncPath);
  let syncState = await loadSyncState(stateFile);
  if (capLoadedSyncState(syncState)) {
    await saveSyncState(stateFile, syncState);
  }

  // `gatewayFolder` scopes this daemon to a subtree of the gateway. An empty
  // string (the default) = full mirror: local syncPath maps 1:1 to the
  // user's sync root. A value like "audit" = scoped mode, where local paths
  // get prefixed with `audit/` on the remote and incoming events outside
  // that subtree are ignored. See specs/066-file-sync/follow-ups.md F1.
  const { toRemote, toLocal } = createRemotePrefixMapper(config.gatewayFolder ?? "");
  if (await reconcileMissingConflictCopies(syncState, {
    syncRoot: config.syncPath,
    toLocalPath: toLocal,
  })) {
    await saveSyncState(stateFile, syncState);
  }

  const gatewayClient = {
    gatewayUrl: config.gatewayUrl,
    token: auth.accessToken,
  };

  // Serial commit queue -- the gateway uses optimistic concurrency on
  // manifest writes, so 13 parallel onEvent calls all racing with the same
  // expectedVersion produce 12 conflicts and a 10s timeout per loser.
  // Serializing makes each commit pick up the prior commit's new version.
  const enqueue = createSerialTaskQueue((err) => {
    logger.error({ err }, "Serialized sync task failed");
  });
  let conflictCopyPathIndex = buildUnresolvedConflictCopyPathIndex(syncState);
  const refreshConflictCopyPathIndex = () => {
    conflictCopyPathIndex = buildUnresolvedConflictCopyPathIndex(syncState);
  };

  const watcher = new FileWatcher({
    syncRoot: config.syncPath,
    ignorePatterns,
    onError: (err) => logger.error({ err }, "Watcher event handling failed"),
    onEvent: async (event) => enqueue(async () => {
      if (config.pauseSync) return;

      // Stored under remote-prefixed keys so syncState matches what the
      // gateway sees. Two daemons watching `~/foo` and `~/bar` then write
      // disjoint key spaces (`foo/...` vs `bar/...`).
      const remotePath = toRemote(event.path);
      const isUnresolvedConflictCopy = hasUnresolvedConflictCopyPath(
        conflictCopyPathIndex,
        remotePath,
      );

      if (event.type === "change") {
        const existing = syncState.files[remotePath];
        // Skip remote-synced files on watcher replay and local-only conflict
        // copies that should never be uploaded to the remote manifest.
        if (shouldSkipWatcherUpload(existing, event.hash, isUnresolvedConflictCopy)) {
          if (
            existing &&
            (existing.hash !== event.hash ||
              existing.mtime !== event.mtime ||
              existing.size !== event.size)
          ) {
            existing.hash = event.hash;
            existing.mtime = event.mtime;
            existing.size = event.size;
            await saveSyncState(stateFile, syncState);
          }
          if (isUnresolvedConflictCopy && !existing) {
            syncState.files[remotePath] = {
              hash: event.hash,
              mtime: event.mtime,
              size: event.size,
              lastSyncedHash: event.hash,
              localOnly: true,
            };
            capSyncStateFiles(syncState);
            await saveSyncState(stateFile, syncState);
          }
          return;
        }

        const nextState = {
          hash: event.hash,
          mtime: event.mtime,
          size: event.size,
          lastSyncedHash: existing?.lastSyncedHash,
        };
        syncState.files[remotePath] = nextState;
        capSyncStateFiles(syncState);

        try {
          const urls = await requestPresignedUrls(gatewayClient, [
            { path: remotePath, action: "put", hash: event.hash, size: event.size },
          ]);
          if (urls[0]) {
            await uploadFile(
              urls[0].url,
              join(config.syncPath, event.path),
            );
            const result = await commitFiles(gatewayClient, [
              { path: remotePath, hash: event.hash, size: event.size },
            ], syncState.manifestVersion);
            syncState.files[remotePath]!.lastSyncedHash = event.hash;
            syncState.manifestVersion = result.manifestVersion;
            await saveSyncState(stateFile, syncState);
          }
        } catch (err) {
          if (existing) {
            syncState.files[remotePath] = existing;
          } else {
            delete syncState.files[remotePath];
          }
          if (exitOnAuthFailure(err, logger)) return;
          await adoptRemoteManifestVersion(syncState, err, async () => {
            await saveSyncState(stateFile, syncState);
          });
          logger.error({ err, path: remotePath }, "Upload failed");
        }
      } else if (event.type === "unlink") {
        const entry = syncState.files[remotePath];
        if (shouldCommitWatcherDelete(entry, isUnresolvedConflictCopy)) {
          try {
            const deleteResult = await commitFiles(gatewayClient, [
              {
                path: remotePath,
                hash: entry.hash,
                size: 0,
                action: "delete",
              },
            ], syncState.manifestVersion);
            delete syncState.files[remotePath];
            syncState.manifestVersion = deleteResult.manifestVersion;
            await saveSyncState(stateFile, syncState);
          } catch (err) {
            if (exitOnAuthFailure(err, logger)) return;
            await adoptRemoteManifestVersion(syncState, err, async () => {
              await saveSyncState(stateFile, syncState);
            });
            logger.error({ err, path: remotePath }, "Delete commit failed");
          }
        } else if (entry?.localOnly || isUnresolvedConflictCopy) {
          delete syncState.files[remotePath];
          if (isUnresolvedConflictCopy) {
            resolveConflictCopyPath(syncState, conflictCopyPathIndex, remotePath);
          }
          await saveSyncState(stateFile, syncState);
        }
      }
    }),
  });

  const wsClient = new SyncWsClient({
    gatewayUrl: config.gatewayUrl,
    token: auth.accessToken,
    peerId: config.peerId,
    onEvent: async (event) => enqueue(async () => {
      if (config.pauseSync) return;
      if (event.type !== "sync:change") return;

      let shouldAdvanceManifestVersion = true;

      for (const file of event.files) {
        // Only react to events for files inside our prefix. A daemon syncing
        // `~/audit` (prefix "audit") ignores changes another peer made to
        // `notes/foo.md`.
        const localRel = toLocal(file.path);
        if (!localRel) continue;

        if (file.action !== "delete") {
          try {
            const urls = await requestPresignedUrls(gatewayClient, [
              { path: file.path, action: "get" },
            ]);
            if (!urls[0]) {
              shouldAdvanceManifestVersion = false;
              continue;
            }
            const result = await reconcileRemoteFileChange(syncState, {
              syncRoot: config.syncPath,
              localRel,
              remotePath: file.path,
              remoteHash: file.hash,
              remoteSize: file.size,
              remotePeerId: event.peerId,
              toRemotePath: toRemote,
              onConflictCleanupError: (cleanupErr, conflictPath) => {
                logger.warn(
                  { err: cleanupErr, path: conflictPath },
                  "Failed to clean up reserved conflict path after download error",
                );
              },
              downloadRemote: (targetPath) => downloadFile(
                urls[0]!.url,
                targetPath,
                file.hash,
              ),
            });
            if (result.status === "conflict-created") {
              logger.warn(
                { path: file.path, conflictPath: result.conflictPath },
                "Remote change conflicted with local edits; preserved both files",
              );
            }
            refreshConflictCopyPathIndex();
            await saveSyncState(stateFile, syncState);
          } catch (err) {
            shouldAdvanceManifestVersion = false;
            if (exitOnAuthFailure(err, logger)) return;
            logger.error({ err, path: file.path }, "Download failed");
          }
        } else {
          try {
            const result = await reconcileRemoteDelete(syncState, {
              syncRoot: config.syncPath,
              localRel,
              remotePath: file.path,
              remoteHash: file.hash,
              remotePeerId: event.peerId,
              toRemotePath: toRemote,
            });
            if (result.status === "delete-skipped-conflict") {
              logger.warn(
                { path: file.path, conflictPath: result.conflictPath },
                "Remote delete conflicted with local edits; kept local file",
              );
            }
            refreshConflictCopyPathIndex();
            await saveSyncState(stateFile, syncState);
          } catch (err) {
            shouldAdvanceManifestVersion = false;
            logger.error(
              { err, path: file.path },
              "Local delete failed",
            );
          }
        }
      }

      await adoptSyncChangeManifestVersion(
        syncState,
        event,
        shouldAdvanceManifestVersion,
        () => saveSyncState(stateFile, syncState),
      );
    }),
    onConnect: () => logger.info("Connected to gateway"),
    onDisconnect: () => logger.info("Disconnected from gateway"),
    onError: (err) => logger.error({ err }, "WebSocket error"),
  });

  const authFileAccessors = createDaemonAuthFileAccessors({ profileName, source }, configDir);
  const ipcHandler = createIpcHandler({
    config,
    syncState,
    logger: { info: (msg) => logger.info(msg) },
    saveConfig: (next) => saveConfig(next),
    persistPauseState,
    clearAuth: authFileAccessors.clearAuth,
    loadAuth: authFileAccessors.loadAuth,
    shell: createDaemonShellControlClient({ config, loadAuth: authFileAccessors.loadAuth }),
    exit: (code) => process.exit(code),
  });
  const ipcServer = new IpcServer({ socketPath, handler: ipcHandler });

  const shutdown = async () => {
    logger.info("Shutting down daemon");
    await watcher.stop();
    wsClient.close();
    await ipcServer.stop();
    try {
      await unlink(pidFile);
    } catch (err: unknown) {
      if (
        !(err instanceof Error) ||
        !("code" in err) ||
        (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        logger.warn({ err }, "Failed to remove daemon pid file during shutdown");
      }
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await ipcServer.start();

  // Wait for the gateway's manifest to be populated before we start pushing
  // local files up. On first provisioning the container may still be seeding
  // its home directory; if we race past that we end up uploading our local
  // state into an empty remote instead of merging with what's about to arrive.
  try {
    await waitForManifest({
      gatewayUrl: config.gatewayUrl,
      token: auth.accessToken,
      logger: {
        info: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
        error: (msg) => logger.error(msg),
      },
    });
  } catch (err) {
    logger.error({ err }, "waitForManifest failed; exiting");
    throw err;
  }

  // Fetch the remote manifest BEFORE starting the watcher. Two reasons:
  //  1. Pick up the gateway's manifestVersion so the first commit doesn't
  //     race with expectedVersion=0 against a non-empty bucket.
  //  2. Initial-pull: download every file in the manifest that's missing
  //     locally (or stale) so a fresh daemon on a new machine actually
  //     materializes the user's existing files.
  try {
    const remote = await fetchManifest(gatewayClient);
    const remoteEnvelope = parseRemoteManifestEnvelope(remote.manifest);
    const remoteVersion = remoteEnvelope.manifestVersion;
    if (remoteVersion > syncState.manifestVersion) {
      syncState.manifestVersion = remoteVersion;
      await saveSyncState(stateFile, syncState);
      logger.info(
        { manifestVersion: remoteVersion },
        "Synced remote manifest version on startup",
      );
    }

    const remoteFiles = remoteEnvelope.manifest.files;
    await runInitialPull({
      gatewayClient,
      syncRoot: config.syncPath,
      syncState,
      remoteFiles,
      toLocal,
      toRemote,
      logger,
      saveSyncState: () => saveSyncState(stateFile, syncState),
      refreshConflictCopyPathIndex,
    });
  } catch (err) {
    if (exitOnAuthFailure(err, logger)) return;
    logger.warn(
      { err },
      "Could not fetch remote manifest on startup -- continuing with cached version",
    );
  }

  watcher.start();
  wsClient.connect();

  logger.info(
    { syncPath: config.syncPath, peerId: config.peerId },
    "Daemon started",
  );
}

// Only auto-start when invoked as an entry point (tsx / compiled bin).
// Importing this module (e.g. from tests) must not trigger daemon startup.
const isEntrypoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn(
        "[sync/daemon] Failed to compare entrypoint path:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return false;
  }
})();

if (isEntrypoint) {
  startDaemon().catch((err) => {
    console.error("Daemon failed to start:", err);
    process.exit(1);
  });
}
