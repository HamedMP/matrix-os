// Pure, dependency-injected command router for the daemon's IPC socket.
//
// Extracted from `daemon/index.ts` so the command set can be unit-tested
// without booting the watcher / WebSocket / filesystem state. The daemon
// entry wires this into an `IpcServer`; tests can call `createIpcHandler`
// directly with fakes for the pieces that touch the filesystem or process.
import { mkdir } from "node:fs/promises";
import {
  normalizeGatewayFolder,
  resolveSyncPathWithinHome,
  type SyncConfig,
} from "../lib/config.js";
import type { SyncState } from "./types.js";

export interface IpcHandlerLogger {
  info: (msg: string) => void;
}

export interface IpcHandlerDeps {
  config: SyncConfig;
  syncState: SyncState;
  logger: IpcHandlerLogger;
  saveConfig: (config: SyncConfig) => Promise<void>;
  persistPauseState: (
    config: SyncConfig,
    paused: boolean,
  ) => Promise<void>;
  clearAuth: () => Promise<void>;
  exit: (code: number) => void;
  ensureDir?: (path: string) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => void;
}

export type IpcHandler = (
  command: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const DEFAULT_EXIT_DELAY_MS = 50;

export function createIpcHandler(deps: IpcHandlerDeps): IpcHandler {
  const ensureDir =
    deps.ensureDir ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined));
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref());

  return async (command, args) => {
    switch (command) {
      case "status":
        return {
          syncing: !deps.config.pauseSync,
          manifestVersion: deps.syncState.manifestVersion,
          lastSyncAt: deps.syncState.lastSyncAt,
          fileCount: Object.keys(deps.syncState.files).length,
          syncPath: deps.config.syncPath,
          gatewayFolder: deps.config.gatewayFolder ?? "",
          gatewayUrl: deps.config.gatewayUrl,
          platformUrl: deps.config.platformUrl,
          peerId: deps.config.peerId,
        };
      case "pause":
        await deps.persistPauseState(deps.config, true);
        return { paused: true };
      case "resume":
        await deps.persistPauseState(deps.config, false);
        return { paused: false };
      case "getConfig":
        // Token-free projection of the daemon's persisted config. The menu
        // bar app calls this to render a Settings view; auth.json is read
        // separately.
        return {
          syncPath: deps.config.syncPath,
          gatewayFolder: deps.config.gatewayFolder ?? "",
          gatewayUrl: deps.config.gatewayUrl,
          platformUrl: deps.config.platformUrl,
          peerId: deps.config.peerId,
          pauseSync: deps.config.pauseSync,
        };
      case "setSyncPath": {
        // Validate + normalize within $HOME, persist, and signal the client
        // that it must call `restart` before the change takes effect. We
        // intentionally don't tear down the watcher live -- that's exactly
        // what a daemon restart does.
        const raw = typeof args.syncPath === "string" ? args.syncPath : "";
        const newPath = resolveSyncPathWithinHome(raw);
        await ensureDir(newPath);
        const nextSyncPath = { ...deps.config, syncPath: newPath };
        await deps.saveConfig(nextSyncPath);
        deps.config.syncPath = newPath;
        return { syncPath: newPath, restartRequired: true };
      }
      case "setGatewayFolder": {
        const folder = typeof args.gatewayFolder === "string" ? args.gatewayFolder : "";
        const normalizedFolder = normalizeGatewayFolder(folder);
        const nextFolder = { ...deps.config, gatewayFolder: normalizedFolder };
        await deps.saveConfig(nextFolder);
        deps.config.gatewayFolder = normalizedFolder;
        return { gatewayFolder: normalizedFolder, restartRequired: true };
      }
      case "restart":
        // Distinct exit code; launchd / systemd KeepAlive re-launches us.
        // Delay so the IPC response is flushed before the socket closes.
        schedule(() => {
          deps.logger.info("Restart requested via IPC");
          deps.exit(3);
        }, DEFAULT_EXIT_DELAY_MS);
        return { restarting: true };
      case "logout":
        // Wipe auth.json and exit 0. Next launch fails the loadAuth() guard
        // and the daemon stays down until the user runs `matrix login`.
        await deps.clearAuth();
        schedule(() => {
          deps.logger.info("Logout requested via IPC");
          deps.exit(0);
        }, DEFAULT_EXIT_DELAY_MS);
        return { loggedOut: true };
      default:
        throw new Error("Unknown IPC command");
    }
  };
}
