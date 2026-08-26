import { spawn } from "node:child_process";

export interface CanonicalCliProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type CanonicalCliSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: ["ignore", "pipe", "pipe"] },
) => CanonicalCliProcess;

const defaultSpawn: CanonicalCliSpawn = (command, args, options) => spawn(command, args, options);
const CLI_TERMINATION_GRACE_MS = 1_000;
const CLI_FORCE_SETTLE_MS = 250;

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
  onStdout: (chunk: Buffer) => void;
}): Promise<void> {
  const maxStderrBytes = options.maxStderrBytes ?? 8_192;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  const child = (options.spawnFn ?? defaultSpawn)(options.command, options.args, {
    cwd: options.cwd,
    env: options.replaceEnv
      ? options.env
      : { ...process.env, ...options.env } as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  });

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
    const abort = () => terminate(new Error("Provider CLI Run aborted"));
    timeout = setTimeout(() => terminate(new Error("Provider CLI Run timed out")), options.timeoutMs);
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
        terminate(new Error("Provider CLI output exceeded limit"));
        return;
      }
      try {
        options.onStdout(chunk);
      } catch (error: unknown) {
        terminate(new Error("Provider CLI output was invalid", { cause: error }));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = Math.min(maxStderrBytes, stderrBytes + chunk.byteLength);
    });
    child.once("error", (error) => finish(terminationError ?? new Error("Provider CLI could not start", { cause: error })));
    child.once("exit", (code, signal) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0 && signal === null) finish();
      else finish(new Error("Provider CLI exited unsuccessfully"));
    });
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
