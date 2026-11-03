import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { runCanonicalCli, type CanonicalCliIdleControl } from "../../packages/gateway/src/chat/cli-process.js";

afterEach(() => vi.useRealTimers());

function start(timeoutMs?: number) {
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: new EventEmitter(),
    stdin: { write: (_frame: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } },
    kill: vi.fn((signal: NodeJS.Signals) => { queueMicrotask(() => child.emit("exit", null, signal)); }),
  });
  let idle: CanonicalCliIdleControl | undefined;
  let write: ((frame: string) => Promise<void>) | undefined;
  const controller = new AbortController();
  const result = runCanonicalCli({ command: "provider", args: [], cwd: "/tmp", env: {},
    signal: controller.signal, idleTimeoutMs: 30, timeoutMs, maxStdoutBytes: 32,
    spawnFn: () => child, onStdout: () => undefined,
    onStart: (send, _end, control) => { write = send; idle = control; },
  }).catch((error: unknown) => error);
  return { child, controller, result, pause: () => idle?.pause(), resume: () => idle?.resume(), write: (frame: string) => write!(frame) };
}

it("suspends idle across accepted stdout and stdin, then starts a fresh interval", async () => {
  vi.useFakeTimers();
  const run = start();
  await vi.advanceTimersByTimeAsync(29);
  run.pause();
  run.child.stdout.emit("data", Buffer.from("waiting"));
  await run.write("accepted\n");
  await vi.advanceTimersByTimeAsync(100);
  expect(run.child.kill).not.toHaveBeenCalled();
  run.resume();
  await vi.advanceTimersByTimeAsync(29);
  expect(run.child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(run.result).resolves.toMatchObject({ kind: "timeout" });
});

it("keeps the absolute deadline active while idle is suspended", async () => {
  vi.useFakeTimers();
  const run = start(100);
  run.pause();
  await vi.advanceTimersByTimeAsync(99);
  expect(run.child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  await expect(run.result).resolves.toMatchObject({ kind: "timeout" });
});

it("ignores late pause/resume after cancellation and clears all timers", async () => {
  vi.useFakeTimers();
  const run = start(100);
  run.pause();
  run.controller.abort();
  await expect(run.result).resolves.toMatchObject({ kind: "aborted" });
  run.resume();
  run.pause();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(vi.getTimerCount()).toBe(0);
});

it("still enforces stdout caps while idle is suspended", async () => {
  vi.useFakeTimers();
  const run = start();
  run.pause();
  run.child.stdout.emit("data", Buffer.alloc(33));
  await expect(run.result).resolves.toMatchObject({ kind: "stdout_limit" });
});
