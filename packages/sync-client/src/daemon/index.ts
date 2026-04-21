import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, unlink, mkdir, stat } from "node:fs/promises";
import pino from "pino";
import {
  loadConfig,
  saveConfig,
  getConfigDir,
  normalizeGatewayFolder,
  resolveSyncPathWithinHome,
  type SyncConfig,
} from "../lib/config.js";
import { clearAuth, isExpired, loadAuth } from "../auth/token-store.js";
import { loadSyncIgnore } from "../lib/syncignore.js";
import { loadSyncState, saveSyncState } from "./manifest-cache.js";
import { FileWatcher } from "./watcher.js";
import { SyncWsClient } from "./ws-client.js";
import { IpcServer } from "./ipc-server.js";
import { createRemotePrefixMapper } from "./remote-prefix.js";
import {
  requestPresignedUrls,
  uploadFile,
  downloadFile,
  commitFiles,
  fetchManifest,
  AuthRejectedError,
  VersionConflictError,
} from "./r2-client.js";
import { ManifestSchema, type SyncState } from "./types.js";

const configDir = getConfigDir();
const stateFile = join(configDir, "sync-state.json");
const socketPath = join(configDir, "daemon.sock");
const pidFile = join(configDir, "daemon.pid");
const SYNC_STATE_FILE_CAP = 50_000;

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
    } catch {
      // Don't propagate the underlying error message — fetch can surface raw
      // server response bytes (HTML, binary) in parse errors, which violates
      // CLAUDE.md § Error Handling. Log a generic message instead.
      opts.logger.warn(
        `Manifest poll attempt ${attempt} failed (network error talking to ${opts.gatewayUrl})`,
      );
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
    } catch {
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

export function capSyncStateFiles(syncState: SyncState): boolean {
  const entries = Object.entries(syncState.files);
  if (entries.length <= SYNC_STATE_FILE_CAP) {
    return false;
  }

  entries
    .sort(([, left], [, right]) => left.mtime - right.mtime)
    .slice(0, entries.length - SYNC_STATE_FILE_CAP)
    .forEach(([path]) => {
      delete syncState.files[path];
    });

  return true;
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

export async function startDaemon(): Promise<void> {
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

  const auth = await loadAuth();
  if (!auth) {
    logger.error("Not logged in. Run 'matrixos login' first.");
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

  const ignorePatterns = await loadSyncIgnore(config.syncPath);
  let syncState = await loadSyncState(stateFile);
  if (capSyncStateFiles(syncState)) {
    await saveSyncState(stateFile, syncState);
  }

  // `gatewayFolder` scopes this daemon to a subtree of the gateway. An empty
  // string (the default) = full mirror: local syncPath maps 1:1 to the
  // user's sync root. A value like "audit" = scoped mode, where local paths
  // get prefixed with `audit/` on the remote and incoming events outside
  // that subtree are ignored. See specs/066-file-sync/follow-ups.md F1.
  const { toRemote, toLocal } = createRemotePrefixMapper(config.gatewayFolder ?? "");

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

      if (event.type === "change") {
        const existing = syncState.files[remotePath];
        // Skip if the on-disk hash already matches what we previously
        // synced AND it's already in the remote manifest. Makes
        // ignoreInitial=false safe on restart -- existing files don't get
        // re-uploaded.
        if (existing?.lastSyncedHash === event.hash) {
          if (existing.mtime !== event.mtime || existing.size !== event.size) {
            existing.mtime = event.mtime;
            existing.size = event.size;
            await saveSyncState(stateFile, syncState);
          }
          return;
        }

        syncState.files[remotePath] = {
          hash: event.hash,
          mtime: event.mtime,
          size: event.size,
          lastSyncedHash: existing?.lastSyncedHash,
        };
        capSyncStateFiles(syncState);
        await saveSyncState(stateFile, syncState);

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
          if (exitOnAuthFailure(err, logger)) return;
          await adoptRemoteManifestVersion(syncState, err, async () => {
            await saveSyncState(stateFile, syncState);
          });
          logger.error({ err, path: remotePath }, "Upload failed");
        }
      } else if (event.type === "unlink") {
        const entry = syncState.files[remotePath];
        if (entry?.lastSyncedHash) {
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

      // Only react to events for files inside our prefix. A daemon syncing
      // `~/audit` (prefix "audit") ignores changes another peer made to
      // `notes/foo.md`.
      const localRel = "path" in event ? toLocal(event.path) : null;
      if (!localRel) return;

      if (event.type === "sync:change" && event.action !== "delete") {
        try {
          const urls = await requestPresignedUrls(gatewayClient, [
            { path: event.path, action: "get" },
          ]);
          if (urls[0]) {
            const localPath = resolveWithinSyncRoot(config.syncPath, localRel);
            await downloadFile(
              urls[0].url,
              localPath,
              event.hash,
            );
            const downloadedStat = await stat(localPath);
            syncState.files[event.path] = {
              hash: event.hash,
              mtime: downloadedStat.mtimeMs,
              size: downloadedStat.size,
              lastSyncedHash: event.hash,
            };
            capSyncStateFiles(syncState);
            await saveSyncState(stateFile, syncState);
          }
        } catch (err) {
          if (exitOnAuthFailure(err, logger)) return;
          logger.error({ err, path: event.path }, "Download failed");
        }
      } else if (
        event.type === "sync:change" &&
        event.action === "delete"
      ) {
        try {
          const localPath = resolveWithinSyncRoot(config.syncPath, localRel);
          const { unlink: unlinkFile } = await import("node:fs/promises");
          try {
            await unlinkFile(localPath);
          } catch (err: unknown) {
            if (
              !(err instanceof Error) ||
              !("code" in err) ||
              (err as NodeJS.ErrnoException).code !== "ENOENT"
            ) {
              throw err;
            }
          }
          delete syncState.files[event.path];
          await saveSyncState(stateFile, syncState);
        } catch (err) {
          logger.error(
            { err, path: event.path },
            "Local delete failed",
          );
        }
      }
    }),
    onConnect: () => logger.info("Connected to gateway"),
    onDisconnect: () => logger.info("Disconnected from gateway"),
    onError: (err) => logger.error({ err }, "WebSocket error"),
  });

  const ipcServer = new IpcServer({
    socketPath,
    handler: async (command, args) => {
      switch (command) {
        case "status":
          return {
            syncing: !config.pauseSync,
            manifestVersion: syncState.manifestVersion,
            lastSyncAt: syncState.lastSyncAt,
            fileCount: Object.keys(syncState.files).length,
            syncPath: config.syncPath,
            gatewayFolder: config.gatewayFolder ?? "",
            gatewayUrl: config.gatewayUrl,
            platformUrl: config.platformUrl,
            peerId: config.peerId,
          };
        case "pause":
          await persistPauseState(config, true);
          return { paused: true };
        case "resume":
          await persistPauseState(config, false);
          return { paused: false };
        case "getConfig":
          // Exposes the full persisted config (without auth tokens) so the
          // menu bar app can render a Settings view. Token lives in auth.json
          // and is fetched separately via /me on the platform.
          return {
            syncPath: config.syncPath,
            gatewayFolder: config.gatewayFolder ?? "",
            gatewayUrl: config.gatewayUrl,
            platformUrl: config.platformUrl,
            peerId: config.peerId,
            pauseSync: config.pauseSync,
          };
        case "setSyncPath": {
          // Writes the new path to config.json and asks the caller to
          // restart the daemon. Changing syncPath live would require tearing
          // down the FileWatcher + restarting the initial-pull, which is
          // exactly what a daemon restart does -- so we stop short of that
          // here and let the client call `restart` next.
          const raw = typeof args.syncPath === "string" ? args.syncPath : "";
          const newPath = resolveSyncPathWithinHome(raw);
          await mkdir(newPath, { recursive: true });
          const updated = { ...config, syncPath: newPath };
          await saveConfig(updated);
          return { syncPath: newPath, restartRequired: true };
        }
        case "setGatewayFolder": {
          // Same semantics as setSyncPath -- persist, caller restarts.
          const folder = typeof args.gatewayFolder === "string" ? args.gatewayFolder : "";
          const normalizedFolder = normalizeGatewayFolder(folder);
          const updated = { ...config, gatewayFolder: normalizedFolder };
          await saveConfig(updated);
          return { gatewayFolder: normalizedFolder, restartRequired: true };
        }
        case "restart":
          // Exit with a distinct code; launchd's KeepAlive will restart us.
          // Schedule after the IPC response is flushed so the client sees
          // "restarting" before the socket closes.
          setTimeout(() => {
            logger.info("Restart requested via IPC");
            process.exit(3);
          }, 50);
          return { restarting: true };
        case "logout":
          // Wipe the auth token and exit. Next launch will fail the
          // loadAuth() guard and the daemon stays down until the user runs
          // `matrix login` again.
          await clearAuth();
          setTimeout(() => {
            logger.info("Logout requested via IPC");
            process.exit(0);
          }, 50);
          return { loggedOut: true };
        default:
          throw new Error(`Unknown command: ${command}`);
      }
    },
  });

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
    const remoteEnvelope = remote.manifest as {
      manifestVersion?: number;
      manifest?: { files?: Record<string, { hash: string; size: number; mtime: number; peerId: string; version: number }> };
    };
    const remoteVersion =
      typeof remoteEnvelope?.manifestVersion === "number"
        ? remoteEnvelope.manifestVersion
        : 0;
    if (remoteVersion > syncState.manifestVersion) {
      syncState.manifestVersion = remoteVersion;
      await saveSyncState(stateFile, syncState);
      logger.info(
        { manifestVersion: remoteVersion },
        "Synced remote manifest version on startup",
      );
    }

    const remoteFiles = remoteEnvelope?.manifest?.files ?? {};
    let pulled = 0;
    let skipped = 0;
    for (const [remotePath, entry] of Object.entries(remoteFiles)) {
      if (!entry?.hash) continue;
      // Only pull files that belong to our prefix. A daemon for `~/audit`
      // doesn't materialize `notes/...` from the same gateway.
      const localRel = toLocal(remotePath);
      if (!localRel) continue;

      const cached = syncState.files[remotePath];
      if (cached?.lastSyncedHash === entry.hash) {
        skipped++;
        continue;
      }

      try {
        const urls = await requestPresignedUrls(gatewayClient, [
          { path: remotePath, action: "get" },
        ]);
        if (!urls[0]) continue;

        const localAbsPath = resolveWithinSyncRoot(config.syncPath, localRel);
        await downloadFile(urls[0].url, localAbsPath, entry.hash);
        syncState.files[remotePath] = {
          hash: entry.hash,
          mtime: entry.mtime,
          size: entry.size,
          lastSyncedHash: entry.hash,
        };
        pulled++;
      } catch (err) {
        if (exitOnAuthFailure(err, logger)) return;
        logger.error({ err, path: remotePath }, "Initial-pull failed");
      }
    }
    if (pulled > 0 || skipped > 0) {
      await saveSyncState(stateFile, syncState);
      logger.info({ pulled, skipped }, "Initial pull complete");
    }
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
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  startDaemon().catch((err) => {
    console.error("Daemon failed to start:", err);
    process.exit(1);
  });
}
