import { createShellClient, type ShellClient } from "../../shell-client.js";
import { createTuiSafeError, normalizeTuiError } from "../errors.js";
import { createTuiShellSessionClient, type TuiShellSessionClient } from "../shell-sessions.js";
import type { MatrixSessionSummary } from "../session-types.js";

export interface ShellSessionTuiAdapter {
  list(): Promise<MatrixSessionSummary[]>;
  createDefault(): Promise<Record<string, unknown>>;
  attach(name: string): Promise<{ detached: boolean }>;
  remove(name: string): Promise<void>;
}

export interface ShellSessionTuiAdapterOptions {
  gatewayUrl: string;
  token?: string;
  shellClient?: ShellClient;
}

export type SessionKeyboardIntent = "attach" | "create" | "refresh" | "remove" | "close" | "none";

export function resolveSessionKeyboardIntent(input: string, key: { return?: boolean; escape?: boolean } = {}): SessionKeyboardIntent {
  if (key.escape) return "close";
  if (key.return) return "attach";
  if (input === "n") return "create";
  if (input === "r") return "refresh";
  if (input === "k") return "remove";
  return "none";
}

export function selectedShellSession(sessions: readonly MatrixSessionSummary[], selectedIndex: number): MatrixSessionSummary | undefined {
  return selectedIndex >= 0 && selectedIndex < sessions.length ? sessions[selectedIndex] : undefined;
}

export function createShellSessionTuiAdapter(options: ShellSessionTuiAdapterOptions): ShellSessionTuiAdapter {
  const shell = createTuiShellSessionClient(options.shellClient ?? createShellClient({
    gatewayUrl: options.gatewayUrl,
    token: options.token,
  }));
  return createShellSessionTuiAdapterFromClient(shell);
}

export function createShellSessionTuiAdapterFromClient(shell: TuiShellSessionClient): ShellSessionTuiAdapter {
  return {
    async list() {
      return shell.list();
    },
    async createDefault() {
      try {
        return await shell.create({ name: "main" });
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async attach(name) {
      if (!name.trim()) {
        throw createTuiSafeError("invalid_request");
      }
      return shell.attach(name);
    },
    async remove(name) {
      if (!name.trim()) {
        throw createTuiSafeError("invalid_request");
      }
      await shell.remove(name, { force: false });
    },
  };
}
