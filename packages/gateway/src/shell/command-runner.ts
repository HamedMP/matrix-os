import { spawn as nodeSpawn } from "node:child_process";
import { shellError } from "./errors.js";
import { resolveShellCwd } from "./names.js";

type Spawn = typeof nodeSpawn;

export interface ShellCommandRunInput {
  command: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ShellCommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface ShellCommandRunner {
  run(input: ShellCommandRunInput): Promise<ShellCommandRunResult>;
}

export interface ShellCommandRunnerOptions {
  homePath: string;
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
}

const SAFE_COMMAND_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "XDG_RUNTIME_DIR",
]);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const SIGKILL_GRACE_MS = 5_000;

function commandEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_COMMAND_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  env.TERM = "dumb";
  return env;
}

function boundedTimeout(input: number | undefined, defaultTimeoutMs: number, maxTimeoutMs: number): number {
  const value = input ?? Number.NaN;
  if (!Number.isFinite(value)) {
    return defaultTimeoutMs;
  }
  return Math.min(Math.max(Math.trunc(value), 1), maxTimeoutMs);
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, maxBytes: number): void {
  if (state.bytes >= maxBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maxBytes - state.bytes;
  const next = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(next);
  state.bytes += next.byteLength;
  if (next.byteLength < chunk.byteLength) {
    state.truncated = true;
  }
}

export function createShellCommandRunner(options: ShellCommandRunnerOptions): ShellCommandRunner {
  const spawnImpl = options.spawn ?? nodeSpawn;
  const env = commandEnv(options.env);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    async run(input) {
      const cwd = await resolveShellCwd(input.cwd, options.homePath);
      const [command, ...args] = input.command;
      if (!command) {
        throw shellError("invalid_request", "Invalid request", 400);
      }
      const timeoutMs = boundedTimeout(input.timeoutMs, defaultTimeoutMs, maxTimeoutMs);
      const startedAt = Date.now();

      return await new Promise<ShellCommandRunResult>((resolve) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const stdoutState = { bytes: 0, truncated: false };
        const stderrState = { bytes: 0, truncated: false };
        let settled = false;
        let timedOut = false;
        let child: ReturnType<Spawn> | null = null;
        let killTimer: NodeJS.Timeout | null = null;

        const finish = (result: Omit<ShellCommandRunResult, "stdout" | "stderr" | "truncated" | "durationMs">) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killTimer) {
            clearTimeout(killTimer);
          }
          resolve({
            ...result,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            truncated: stdoutState.truncated || stderrState.truncated,
            durationMs: Date.now() - startedAt,
          });
        };

        const timer = setTimeout(() => {
          timedOut = true;
          child?.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child?.kill("SIGKILL");
          }, SIGKILL_GRACE_MS);
          killTimer.unref?.();
        }, timeoutMs);
        timer.unref?.();

        try {
          child = spawnImpl(command, args, {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err: unknown) {
          if (!(err instanceof Error && "code" in err)) {
            console.warn("[shell-run] Failed to start command:", err instanceof Error ? err.name : typeof err);
          }
          finish({
            exitCode: 127,
            signal: null,
            timedOut: false,
          });
          return;
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          appendBounded(stdout, chunk, stdoutState, maxOutputBytes);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          appendBounded(stderr, chunk, stderrState, maxOutputBytes);
        });
        child.on("error", (err: Error) => {
          console.warn("[shell-run] Command error:", err.name);
          finish({
            exitCode: 127,
            signal: null,
            timedOut: false,
          });
        });
        child.on("close", (exitCode, signal) => {
          finish({
            exitCode,
            signal,
            timedOut,
          });
        });
      });
    },
  };
}
