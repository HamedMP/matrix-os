import { spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";

export interface CanonicalCliProcess {
  stdin?: { write(chunk: string, callback?: (error?: Error | null) => void): boolean; end?(): void; on?(event: "error", listener: (error: Error) => void): void } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type CanonicalCliSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: ["ignore" | "pipe", "pipe", "pipe"] },
) => CanonicalCliProcess;

const defaultSpawn: CanonicalCliSpawn = (command, args, options) => (
  spawnIsolatedProviderProcess(command, args, options)
);
const CLI_TERMINATION_GRACE_MS = 1_000;
const CLI_FORCE_SETTLE_MS = 250;

export type CanonicalCliFailureKind =
  | "aborted"
  | "timeout"
  | "stdout_limit"
  | "invalid_output"
  | "startup"
  | "exit";

export class CanonicalCliError extends Error {
  readonly name = "CanonicalCliError";

  constructor(
    readonly kind: CanonicalCliFailureKind,
    readonly exitCode?: number | null,
    readonly signal?: NodeJS.Signals | null,
  ) {
    const message = kind === "aborted"
      ? "Provider CLI Run aborted"
      : kind === "timeout"
        ? "Provider CLI Run timed out"
        : kind === "stdout_limit"
          ? "Provider CLI output exceeded limit"
          : kind === "invalid_output"
            ? "Provider CLI output was invalid"
            : kind === "startup"
              ? "Provider CLI could not start"
              : "Provider CLI exited unsuccessfully";
    super(message);
  }
}

export async function runCanonicalCli(options: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  replaceEnv?: boolean;
  signal: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number;
  spawnFn?: CanonicalCliSpawn;
  onStart?: (write: (frame: string) => Promise<void>, end: () => void) => void;
  onStdout: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}): Promise<void> {
  const maxStderrBytes = options.maxStderrBytes ?? 8_192;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let child: CanonicalCliProcess;
  try {
    child = (options.spawnFn ?? defaultSpawn)(options.command, options.args, {
      cwd: options.cwd,
      env: options.replaceEnv
        ? options.env
        : { ...process.env, ...options.env } as Record<string, string>,
      stdio: [options.onStart ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    console.warn(
      "[chat-cli] Provider CLI spawn failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    throw new CanonicalCliError("startup");
  }

  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    let terminationError: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        forceSettleTimer = setTimeout(() => finish(terminationError), CLI_FORCE_SETTLE_MS);
        forceSettleTimer.unref?.();
      }, CLI_TERMINATION_GRACE_MS);
      forceKillTimer.unref?.();
    };
    const abort = () => terminate(new CanonicalCliError("aborted"));
    timeout = setTimeout(() => terminate(new CanonicalCliError("timeout")), options.timeoutMs);
    timeout.unref?.();

    if (options.signal.aborted) {
      abort();
      return;
    }
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      if (settled || terminationError) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxStdoutBytes) {
        terminate(new CanonicalCliError("stdout_limit"));
        return;
      }
      try {
        options.onStdout(chunk);
      } catch (error: unknown) {
        console.warn(
          "[chat-cli] Provider CLI stdout observer failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        terminate(new CanonicalCliError("invalid_output"));
      }
    });
    child.stderr.on("data", (chunk) => {
      const remainingBytes = Math.max(0, maxStderrBytes - stderrBytes);
      if (remainingBytes === 0) return;
      const boundedChunk = chunk.subarray(0, remainingBytes);
      stderrBytes += boundedChunk.byteLength;
      try {
        options.onStderr?.(boundedChunk);
      } catch (error: unknown) {
        console.warn("[chat-cli] Ignoring stderr observer failure:", error instanceof Error ? error.name : "UnknownError");
      }
    });
    child.once("error", () => finish(terminationError ?? new CanonicalCliError("startup")));
    child.once("exit", (code, signal) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0 && signal === null) finish();
      else finish(new CanonicalCliError("exit", code, signal));
    });
    if (options.onStart) {
      child.stdin?.on?.("error", () => terminate(new CanonicalCliError("startup")));
      const write = (frame: string) => new Promise<void>((resolveWrite, rejectWrite) => {
        if (settled || terminationError || !child.stdin) { rejectWrite(new CanonicalCliError("startup")); return; }
        const timer = setTimeout(() => rejectWrite(new CanonicalCliError("timeout")), 10_000);
        timer.unref?.();
        try {
          child.stdin.write(frame, error => { clearTimeout(timer); if (error) rejectWrite(error); else resolveWrite(); });
        } catch (error) { clearTimeout(timer); rejectWrite(error); }
      });
      try { options.onStart(write, () => child.stdin?.end?.()); } catch (error) {
        console.warn("[chat-cli] Provider stdin setup failed", error instanceof Error ? error.name : "UnknownError");
        terminate(new CanonicalCliError("startup"));
      }
    }
  });
}

export interface CanonicalCliEventQueue<T> {
  push(value: T): void;
  finish(error?: Error): void;
  values(): AsyncGenerator<T>;
}

export function createCanonicalCliEventQueue<T>(limit = 500): CanonicalCliEventQueue<T> {
  const queued: T[] = [];
  let done = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  return {
    push(value) {
      if (done) return;
      if (queued.length >= limit) {
        this.finish(new Error("Provider CLI event buffer exceeded"));
        return;
      }
      queued.push(value);
      wake?.();
      wake = undefined;
    },
    finish(error) {
      if (done) return;
      done = true;
      failure = error;
      wake?.();
      wake = undefined;
    },
    async *values() {
      while (!done || queued.length > 0) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
    },
  };
}
