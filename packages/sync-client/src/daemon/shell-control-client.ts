import type { AuthData } from "../auth/token-store.js";
import type { SyncConfig } from "../lib/config.js";
import { createShellClient } from "../cli/shell-client.js";

export interface DaemonShellControlClientOptions {
  config: SyncConfig;
  loadAuth: () => Promise<AuthData | null>;
}

export function createDaemonShellControlClient(options: DaemonShellControlClientOptions) {
  async function client() {
    const auth = await options.loadAuth();
    return createShellClient({ gatewayUrl: options.config.gatewayUrl, token: auth?.accessToken, timeoutMs: 10_000 });
  }

  return {
    async listWorkspaces() {
      return (await client()).listWorkspaces();
    },
    async ensureWorkspace(input: { projectId?: string }) {
      return (await client()).ensureWorkspace(input);
    },
    async createTab(workspaceId: string, input: { name: string; cwd?: string; command?: string[] }) {
      return (await client()).createTab(workspaceId, input);
    },
    async terminateTab(ref: { workspaceId: string; tabId: string }) {
      return (await client()).terminateTab(ref);
    },
  };
}
