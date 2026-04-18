import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import pino from "pino";
import { loadConfig, getConfigDir } from "../lib/config.js";
import { loadSyncIgnore } from "../lib/syncignore.js";
import { loadAuth } from "../auth/token-store.js";
import { loadSyncState, saveSyncState } from "./manifest-cache.js";
import { detectChanges, buildPresignBatch } from "./sync-engine.js";
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
} from "./r2-client.js";
import { ManifestSchema, type SyncState } from "./types.js";

const configDir = getConfigDir();
const stateFile = join(configDir, "sync-state.json");
const socketPath = join(configDir, "daemon.sock");
const pidFile = join(configDir, "daemon.pid");

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

  await writeFile(pidFile, String(process.pid));

  const ignorePatterns = await loadSyncIgnore(config.syncPath);
  let syncState = await loadSyncState(stateFile);

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
  let commitChain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = commitChain.then(fn, fn);
    commitChain = next.catch(() => undefined);
    return next;
  };

  const watcher = new FileWatcher({
    syncRoot: config.syncPath,
    ignorePatterns,
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
        await saveSyncState(stateFile, syncState);

        try {
          const urls = await requestPresignedUrls(gatewayClient, [
            { path: remotePath, action: "put", hash: event.hash },
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
            await downloadFile(
              urls[0].url,
              join(config.syncPath, localRel),
            );
            syncState.files[event.path] = {
              hash: event.hash,
              mtime: Date.now(),
              size: 0,
              lastSyncedHash: event.hash,
            };
            await saveSyncState(stateFile, syncState);
          }
        } catch (err) {
          logger.error({ err, path: event.path }, "Download failed");
        }
      } else if (
        event.type === "sync:change" &&
        event.action === "delete"
      ) {
        try {
          const localPath = join(config.syncPath, localRel);
          const { unlink: unlinkFile } = await import("node:fs/promises");
          await unlinkFile(localPath).catch(() => {});
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
    handler: async (command, _args) => {
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
            peerId: config.peerId,
          };
        case "pause":
          config.pauseSync = true;
          return { paused: true };
        case "resume":
          config.pauseSync = false;
          return { paused: false };
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
    await unlink(pidFile).catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await ipcServer.start();

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

        const localAbsPath = join(config.syncPath, localRel);
        await downloadFile(urls[0].url, localAbsPath);
        syncState.files[remotePath] = {
          hash: entry.hash,
          mtime: entry.mtime,
          size: entry.size,
          lastSyncedHash: entry.hash,
        };
        pulled++;
      } catch (err) {
        logger.error({ err, path: remotePath }, "Initial-pull failed");
      }
    }
    if (pulled > 0 || skipped > 0) {
      await saveSyncState(stateFile, syncState);
      logger.info({ pulled, skipped }, "Initial pull complete");
    }
  } catch (err) {
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

startDaemon().catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
