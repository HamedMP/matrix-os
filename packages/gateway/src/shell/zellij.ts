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

  function run(args: string[], timeout = timeoutMs): Promise<string> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const child = execFile(
        "zellij",
        args,
        { timeout, signal: controller.signal },
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
      args.push("attach", "--create", options.name);
      if (options.cmd) args.push("--", options.cmd);
      await run(args);
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
  };
}
