import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";
import { shellError, type ShellSafeError } from "./errors.js";

type ExecFile = typeof nodeExecFile;
type Spawn = typeof nodeSpawn;

export interface ZellijAdapterDeps {
  execFile?: ExecFile;
  spawn?: Spawn;
  timeoutMs?: number;
}

export interface CreateSessionOptions {
  name: string;
  cwd?: string;
  layout?: string;
  cmd?: string;
}

export interface AttachOptions {
  signal?: AbortSignal;
}

export interface ZellijAdapter {
  listSessions(): Promise<string[]>;
  createSession(options: CreateSessionOptions): Promise<void>;
  deleteSession(name: string, options?: { force?: boolean }): Promise<void>;
  validateLayout(path: string): Promise<void>;
  attachSession(name: string, options?: AttachOptions): ChildProcess;
  listTabs(name: string): Promise<unknown[]>;
  createTab(name: string, input: { name?: string; cwd?: string; cmd?: string }): Promise<unknown>;
  switchTab(name: string, tab: number): Promise<unknown>;
  closeTab(name: string, tab: number): Promise<unknown>;
  splitPane(name: string, input: { direction: "right" | "down"; cwd?: string; cmd?: string }): Promise<unknown>;
  closePane(name: string, pane: string): Promise<unknown>;
  applyLayout(name: string, layout: string): Promise<unknown>;
  dumpLayout(name: string): Promise<unknown>;
}

export function sanitizeZellijError(stderr: string): string {
  return stderr
    .replace(/\/(?:home|tmp|var|app|workspace|Users)\/[^\s)]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s)]+/g, "[path]")
    .trim();
}

export function createZellijAdapter(deps: ZellijAdapterDeps = {}): ZellijAdapter {
  const execFile = deps.execFile ?? nodeExecFile;
  const spawn = deps.spawn ?? nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  function run(args: string[], timeout = timeoutMs, cwd?: string): Promise<string> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const child = execFile(
        "zellij",
        args,
        { timeout, signal: controller.signal, cwd },
        (err, stdout, stderr) => {
          if (err) {
            const safe = shellError("zellij_failed", "Shell operation failed", 500);
            (safe as ShellSafeError & { cause?: unknown; stderr?: string }).cause = err;
            (safe as ShellSafeError & { stderr?: string }).stderr = sanitizeZellijError(
              typeof stderr === "string" ? stderr : String(stderr ?? ""),
            );
            reject(safe);
            return;
          }
          resolve(String(stdout));
        },
      );
      child.once?.("error", (err) => reject(err));
    });
  }

  return {
    async listSessions() {
      const stdout = await run(["list-sessions", "--no-formatting"]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean);
    },
    async createSession(options) {
      const args = ["--session", options.name];
      if (options.layout) args.push("--layout", options.layout);
      args.push("attach", "--create-background", options.name);
      await run(args, timeoutMs, options.cwd);
      if (options.cmd) {
        const commandArgs = ["--session", options.name, "action", "new-pane"];
        if (options.cwd) commandArgs.push("--cwd", options.cwd);
        commandArgs.push("--", ...splitCommand(options.cmd));
        await run(commandArgs);
      }
    },
    async deleteSession(name, options = {}) {
      const args = ["delete-session", name];
      if (options.force) args.push("--force");
      await run(args);
    },
    async validateLayout(path) {
      await run(["setup", "--check", "--layout", path], 5_000);
    },
    attachSession(name, options = {}) {
      const child = spawn("zellij", ["attach", name], { stdio: "pipe" });
      const abort = () => {
        child.kill();
      };
      if (options.signal?.aborted) {
        abort();
      } else {
        options.signal?.addEventListener("abort", abort, { once: true });
      }
      child.once?.("close", () => options.signal?.removeEventListener("abort", abort));
      child.once?.("error", () => options.signal?.removeEventListener("abort", abort));
      return child;
    },
    async listTabs(name) {
      const stdout = await run(["--session", name, "action", "query-tab-names"]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((tab, idx) => ({ idx, name: tab }));
    },
    async createTab(name, input) {
      const args = ["--session", name, "action", "new-tab"];
      if (input.name) args.push("--name", input.name);
      if (input.cwd) args.push("--cwd", input.cwd);
      if (input.cmd) args.push("--", ...splitCommand(input.cmd));
      await run(args);
      return { ok: true };
    },
    async switchTab(name, tab) {
      await run(["--session", name, "action", "go-to-tab", String(tab)]);
      return { ok: true };
    },
    async closeTab(name, tab) {
      await run(["--session", name, "action", "close-tab", String(tab)]);
      return { ok: true };
    },
    async splitPane(name, input) {
      const args = [
        "--session",
        name,
        "action",
        "new-pane",
        input.direction === "right" ? "--right" : "--down",
      ];
      if (input.cwd) args.push("--cwd", input.cwd);
      if (input.cmd) args.push("--", ...splitCommand(input.cmd));
      await run(args);
      return { ok: true };
    },
    async closePane(name, pane) {
      await run(["--session", name, "action", "close-pane", "--pane-id", pane]);
      return { ok: true };
    },
    async applyLayout(name, layout) {
      await run(["--session", name, "action", "new-tab", "--layout", layout]);
      return { ok: true };
    },
    async dumpLayout(name) {
      const kdl = await run(["--session", name, "action", "dump-layout"]);
      return { kdl };
    },
  };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote !== null) {
    throw shellError("invalid_command", "Invalid command", 400);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    throw shellError("invalid_command", "Invalid command", 400);
  }
  return parts;
}
