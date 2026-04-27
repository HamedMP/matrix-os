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
    return createShellClient({
      gatewayUrl: options.config.gatewayUrl,
      token: auth?.accessToken,
      timeoutMs: 10_000,
    });
  }

  return {
    async listSessions() {
      return (await client()).listSessions();
    },
    async createSession(input: Record<string, unknown>) {
      return (await client()).createSession({
        name: String(input.name),
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        layout: typeof input.layout === "string" ? input.layout : undefined,
        cmd: typeof input.cmd === "string" ? input.cmd : undefined,
      });
    },
    async deleteSession(name: string) {
      return (await client()).deleteSession(name);
    },
    async listTabs(session: string) {
      return (await client()).listTabs(session);
    },
    async createTab(session: string, input: Record<string, unknown>) {
      return (await client()).createTab(session, {
        name: typeof input.name === "string" ? input.name : undefined,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        cmd: typeof input.cmd === "string" ? input.cmd : undefined,
      });
    },
    async switchTab(session: string, tab: number) {
      return (await client()).switchTab(session, tab);
    },
    async closeTab(session: string, tab: number) {
      return (await client()).closeTab(session, tab);
    },
    async splitPane(session: string, input: Record<string, unknown>) {
      return (await client()).splitPane(session, {
        direction: input.direction === "down" ? "down" : "right",
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        cmd: typeof input.cmd === "string" ? input.cmd : undefined,
      });
    },
    async closePane(session: string, pane: string) {
      return (await client()).closePane(session, pane);
    },
    async listLayouts() {
      return (await client()).listLayouts();
    },
    async showLayout(name: string) {
      return (await client()).showLayout(name);
    },
    async saveLayout(name: string, kdl: string) {
      return (await client()).saveLayout(name, kdl);
    },
    async applyLayout(session: string, name: string) {
      return (await client()).applyLayout(session, name);
    },
    async deleteLayout(name: string) {
      return (await client()).deleteLayout(name);
    },
  };
}
