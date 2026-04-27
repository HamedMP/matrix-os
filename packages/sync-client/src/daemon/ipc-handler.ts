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
const ShellSessionNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const ShellLayoutNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const ShellCwdSchema = z.string().min(1).max(1024)
  .refine((value) => !value.startsWith("/"))
  .refine((value) => !value.split(/[\\/]+/).includes(".."));
const ShellCommandSchema = z.string().min(1).max(4096);
const ShellTabNameSchema = z.string().min(1).max(64);
const ShellCreateArgsSchema = z.object({
  name: ShellSessionNameSchema,
  cwd: ShellCwdSchema.optional(),
  layout: ShellLayoutNameSchema.optional(),
  cmd: ShellCommandSchema.optional(),
}).strict();
const ShellSessionArgsSchema = z.object({ session: ShellSessionNameSchema }).strict();
const ShellDestroyArgsSchema = z.object({ name: ShellSessionNameSchema }).strict();
const ShellTabCreateArgsSchema = z.object({
  session: ShellSessionNameSchema,
  name: ShellTabNameSchema.optional(),
  cwd: ShellCwdSchema.optional(),
  cmd: ShellCommandSchema.optional(),
}).strict();
const ShellPaneSplitArgsSchema = z.object({
  session: ShellSessionNameSchema,
  direction: z.enum(["right", "down"]),
  cwd: ShellCwdSchema.optional(),
  cmd: ShellCommandSchema.optional(),
}).strict();
const ShellTabArgsSchema = z.object({
  session: ShellSessionNameSchema,
  tab: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]),
}).strict();
const ShellPaneArgsSchema = z.object({
  session: ShellSessionNameSchema,
  pane: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
}).strict();
const LayoutNameArgsSchema = z.object({ name: ShellLayoutNameSchema }).strict();
const LayoutSaveArgsSchema = z.object({
  name: ShellLayoutNameSchema,
  kdl: z.string().min(1).max(100_000),
}).strict();
const LayoutApplyArgsSchema = z.object({
  session: ShellSessionNameSchema,
  name: ShellLayoutNameSchema,
}).strict();

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
      case "shell.create": {
        const input = parseIpcArgs(ShellCreateArgsSchema, args);
        return await requireShell(deps).createSession!(input);
      }
      case "shell.destroy":
        await requireShell(deps).deleteSession!(parseIpcArgs(ShellDestroyArgsSchema, args).name);
        return { ok: true };
      case "tab.list":
        return { tabs: await requireShell(deps).listTabs!(parseIpcArgs(ShellSessionArgsSchema, args).session) };
      case "tab.create": {
        const { session, ...input } = parseIpcArgs(ShellTabCreateArgsSchema, args);
        return await requireShell(deps).createTab!(session, input);
      }
      case "tab.go": {
        const input = parseIpcArgs(ShellTabArgsSchema, args);
        return await requireShell(deps).switchTab!(input.session, input.tab);
      }
      case "tab.close": {
        const input = parseIpcArgs(ShellTabArgsSchema, args);
        return await requireShell(deps).closeTab!(input.session, input.tab);
      }
      case "pane.split": {
        const { session, ...input } = parseIpcArgs(ShellPaneSplitArgsSchema, args);
        return await requireShell(deps).splitPane!(session, input);
      }
      case "pane.close": {
        const input = parseIpcArgs(ShellPaneArgsSchema, args);
        return await requireShell(deps).closePane!(input.session, input.pane);
      }
      case "layout.list":
        return { layouts: await requireShell(deps).listLayouts!() };
      case "layout.show":
        return await requireShell(deps).showLayout!(parseIpcArgs(LayoutNameArgsSchema, args).name);
      case "layout.save": {
        const input = parseIpcArgs(LayoutSaveArgsSchema, args);
        return await requireShell(deps).saveLayout!(
          input.name,
          input.kdl,
        );
      }
      case "layout.apply": {
        const input = parseIpcArgs(LayoutApplyArgsSchema, args);
        return await requireShell(deps).applyLayout!(input.session, input.name);
      }
      case "layout.delete":
        return await requireShell(deps).deleteLayout!(parseIpcArgs(LayoutNameArgsSchema, args).name);
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

function parseIpcArgs<T extends z.ZodType>(schema: T, args: Record<string, unknown>): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error("invalid_request");
  }
  return parsed.data;
}
