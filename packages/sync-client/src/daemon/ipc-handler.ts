// Pure, dependency-injected command router for the daemon's IPC socket.
//
// Extracted from `daemon/index.ts` so the command set can be unit-tested
// without booting the watcher / WebSocket / filesystem state. The daemon
// entry wires this into an `IpcServer`; tests can call `createIpcHandler`
// directly with fakes for the pieces that touch the filesystem or process.
import { mkdir } from "node:fs/promises";
import { z } from "zod/v4";
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
    listWorkspaces?: () => Promise<unknown[]>;
    ensureWorkspace?: (input: { projectId?: string }) => Promise<Record<string, unknown>>;
    createTab?: (workspaceId: string, input: { name: string; cwd?: string; command?: string[] }) => Promise<Record<string, unknown>>;
    terminateTab?: (ref: { workspaceId: string; tabId: string }) => Promise<void>;
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
const TerminalWorkspaceIdSchema = z.string().regex(/^tws_[0-9a-f]{32}$/);
const TerminalTabIdSchema = z.string().regex(/^tt_[0-9a-f]{32}$/);
const ShellCwdSchema = z.string().min(1).max(1024)
  .refine((value) => !value.startsWith("/"))
  .refine((value) => !value.split(/[\\/]+/).includes(".."));
const TerminalEnsureArgsSchema = z.object({ projectId: z.string().regex(/^proj_[0-9a-f]{16,64}$/).optional() }).strict();
const TerminalTabCreateArgsSchema = z.object({
  workspaceId: TerminalWorkspaceIdSchema,
  name: z.string().min(1).max(120),
  cwd: ShellCwdSchema.optional(),
  command: z.array(z.string().min(1).max(4096)).min(1).max(128).optional(),
}).strict();
const TerminalTabRefArgsSchema = z.object({ workspaceId: TerminalWorkspaceIdSchema, tabId: TerminalTabIdSchema }).strict();

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
          conflictCount: Object.keys(deps.syncState.conflicts ?? {}).length,
          syncPath: deps.config.syncPath,
          gatewayFolder: deps.config.gatewayFolder ?? "",
          gatewayUrl: deps.config.gatewayUrl,
          platformUrl: deps.config.platformUrl,
          profile: deps.config.profile,
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
      case "terminal.workspaces.list":
        return { workspaces: await requireShell(deps).listWorkspaces!() };
      case "terminal.workspace.ensure":
        return await requireShell(deps).ensureWorkspace!(parseIpcArgs(TerminalEnsureArgsSchema, args));
      case "terminal.tab.create": {
        const { workspaceId, ...input } = parseIpcArgs(TerminalTabCreateArgsSchema, args);
        return await requireShell(deps).createTab!(workspaceId, input);
      }
      case "terminal.tab.terminate": {
        const ref = parseIpcArgs(TerminalTabRefArgsSchema, args);
        await requireShell(deps).terminateTab!(ref);
        return { ok: true };
      }
      case "getConfig":
        // Token-free projection of the daemon's persisted config. The menu
        // bar app calls this to render a Settings view; auth.json is read
        // separately.
        return {
          syncPath: deps.config.syncPath,
          gatewayFolder: deps.config.gatewayFolder ?? "",
          gatewayUrl: deps.config.gatewayUrl,
          platformUrl: deps.config.platformUrl,
          profile: deps.config.profile,
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

function parseIpcArgs<T extends z.ZodType>(schema: T, args: Record<string, unknown>): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error("invalid_request");
  }
  return parsed.data;
}
