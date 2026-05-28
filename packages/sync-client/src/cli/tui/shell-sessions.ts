import type { ShellClient } from "../shell-client.js";
import { normalizeTuiError } from "./errors.js";
import type { MatrixSessionSummary, ShellRuntimeTab } from "./session-types.js";

export interface TuiShellSessionClient {
  list(): Promise<MatrixSessionSummary[]>;
  create(input: { name: string; cwd?: string; layout?: string; cmd?: string }): Promise<Record<string, unknown>>;
  remove(name: string, options?: { force?: boolean }): Promise<void>;
  attach(name: string): Promise<{ detached: boolean }>;
  listTabs(name: string): Promise<unknown[]>;
  listLayouts(): Promise<unknown[]>;
  splitPane(name: string, input: { direction: "right" | "down"; cwd?: string; cmd?: string }): Promise<Record<string, unknown>>;
  applyLayout(session: string, layout: string): Promise<Record<string, unknown>>;
}

type ShellClientLike = Partial<ShellClient> & {
  listSessions?: () => Promise<unknown[]>;
};

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeStatus(value: string | undefined): string {
  if (!value) return "unknown";
  if (["active", "running", "attached"].includes(value)) return "running";
  return value;
}

export function normalizeShellSession(input: unknown): MatrixSessionSummary {
  if (typeof input === "string") {
    return { id: `shell:${input}`, kind: "shell", name: input, status: "unknown", attention: "unknown" };
  }
  const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const name = readString(record, "name") ?? readString(record, "id") ?? "unnamed";
  const cwd = readString(record, "cwd");
  return {
    id: `shell:${name}`,
    kind: "shell",
    name,
    status: normalizeStatus(readString(record, "status")),
    context: cwd,
    attention: "ready",
  };
}

export function createTuiShellSessionClient(shell: ShellClientLike): TuiShellSessionClient {
  return {
    async list() {
      try {
        return (await shell.listSessions?.() ?? []).map(normalizeShellSession);
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async create(input) {
      if (!shell.createSession) throw normalizeTuiError(new Error("request_failed"));
      try {
        return await shell.createSession(input);
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async remove(name, options) {
      if (!shell.deleteSession) throw normalizeTuiError(new Error("request_failed"));
      try {
        await shell.deleteSession(name, options);
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async attach(name) {
      if (!shell.attachSession) throw normalizeTuiError(new Error("request_failed"));
      try {
        return await shell.attachSession(name);
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async listTabs(name) {
      try {
        return (await shell.listTabs?.(name)) ?? [] satisfies ShellRuntimeTab[];
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async listLayouts() {
      try {
        return (await shell.listLayouts?.()) ?? [];
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async splitPane(name, input) {
      if (!shell.splitPane) throw normalizeTuiError(new Error("request_failed"));
      try {
        return await shell.splitPane(name, input);
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
    async applyLayout(session, layout) {
      if (!shell.applyLayout) throw normalizeTuiError(new Error("request_failed"));
      try {
        return await shell.applyLayout(session, layout);
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
  };
}
