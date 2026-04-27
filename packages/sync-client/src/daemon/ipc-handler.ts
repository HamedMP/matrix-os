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
import type { AuthData } from "../auth/token-store.js";

export interface IpcHandlerLogger {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
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
  loadAuth?: () => Promise<AuthData | null>;
  refreshAuth?: () => Promise<AuthData | null>;
  shell?: {
    listSessions?: () => Promise<unknown[]>;
    createSession?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    deleteSession?: (name: string) => Promise<void>;
    listTabs?: (session: string) => Promise<unknown[]>;
    createTab?: (session: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    switchTab?: (session: string, tab: number) => Promise<Record<string, unknown>>;
    closeTab?: (session: string, tab: number) => Promise<Record<string, unknown>>;
    splitPane?: (session: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    closePane?: (session: string, pane: string) => Promise<Record<string, unknown>>;
    listLayouts?: () => Promise<unknown[]>;
    showLayout?: (name: string) => Promise<Record<string, unknown>>;
    saveLayout?: (name: string, kdl: string) => Promise<Record<string, unknown>>;
    applyLayout?: (session: string, name: string) => Promise<Record<string, unknown>>;
    deleteLayout?: (name: string) => Promise<Record<string, unknown>>;
  };
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
      case "sync.status":
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
      case "sync.pause":
        await deps.persistPauseState(deps.config, true);
        return { paused: true };
      case "resume":
      case "sync.resume":
        await deps.persistPauseState(deps.config, false);
        return { paused: false };
      case "auth.whoami": {
        const auth = await deps.loadAuth?.();
        return auth
          ? { authenticated: true, userId: auth.userId, handle: auth.handle }
          : { authenticated: false };
      }
      case "auth.token": {
        const auth = await deps.loadAuth?.();
        if (!auth) return { authenticated: false };
        return { accessToken: auth.accessToken, expiresAt: auth.expiresAt };
      }
      case "auth.refresh": {
        const auth = await deps.refreshAuth?.() ?? await deps.loadAuth?.();
        if (!auth) return { authenticated: false };
        return { accessToken: auth.accessToken, expiresAt: auth.expiresAt };
      }
      case "shell.list":
        return { sessions: await requireShell(deps).listSessions!() };
      case "shell.create":
        return await requireShell(deps).createSession!(args);
      case "shell.destroy":
        await requireShell(deps).deleteSession!(requireString(args.name, "name_required"));
        return { ok: true };
      case "tab.list":
        return { tabs: await requireShell(deps).listTabs!(requireString(args.session, "session_required")) };
      case "tab.create":
        return await requireShell(deps).createTab!(requireString(args.session, "session_required"), args);
      case "tab.go":
        return await requireShell(deps).switchTab!(
          requireString(args.session, "session_required"),
          requireNumber(args.tab, "tab_required"),
        );
      case "tab.close":
        return await requireShell(deps).closeTab!(
          requireString(args.session, "session_required"),
          requireNumber(args.tab, "tab_required"),
        );
      case "pane.split":
        return await requireShell(deps).splitPane!(requireString(args.session, "session_required"), args);
      case "pane.close":
        return await requireShell(deps).closePane!(
          requireString(args.session, "session_required"),
          requireString(args.pane, "pane_required"),
        );
      case "layout.list":
        return { layouts: await requireShell(deps).listLayouts!() };
      case "layout.show":
        return await requireShell(deps).showLayout!(requireString(args.name, "name_required"));
      case "layout.save":
        return await requireShell(deps).saveLayout!(
          requireString(args.name, "name_required"),
          requireString(args.kdl, "kdl_required"),
        );
      case "layout.apply":
        return await requireShell(deps).applyLayout!(
          requireString(args.session, "session_required"),
          requireString(args.name, "name_required"),
        );
      case "layout.delete":
        return await requireShell(deps).deleteLayout!(requireString(args.name, "name_required"));
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

function requireShell(deps: IpcHandlerDeps): NonNullable<IpcHandlerDeps["shell"]> {
  if (!deps.shell) {
    throw new Error("shell_unavailable");
  }
  return deps.shell;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(code);
  }
  return value;
}

function requireNumber(value: unknown, code: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(code);
  }
  return parsed;
}
