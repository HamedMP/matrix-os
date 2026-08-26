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
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Provider CLI Run aborted"));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Provider CLI Run timed out"));
    }, options.timeoutMs);
    timeout.unref?.();

    if (options.signal.aborted) {
      abort();
      return;
    }
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxStdoutBytes) {
        child.kill("SIGTERM");
        finish(new Error("Provider CLI output exceeded limit"));
        return;
      }
      try {
        options.onStdout(chunk);
      } catch (error: unknown) {
        child.kill("SIGTERM");
        finish(new Error("Provider CLI output was invalid", { cause: error }));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = Math.min(maxStderrBytes, stderrBytes + chunk.byteLength);
    });
    child.once("error", (error) => finish(new Error("Provider CLI could not start", { cause: error })));
    child.once("exit", (code, signal) => {
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
