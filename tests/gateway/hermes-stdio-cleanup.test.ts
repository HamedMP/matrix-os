import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createHermesStdioClient, type HermesGatewayProcess } from "../../packages/gateway/src/chat/hermes-stdio-client";

afterEach(() => vi.useRealTimers());

it("shares a bounded close result without mistaking failed termination calls for exit", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdin: { write: () => true, end: () => { throw new Error("EPIPE"); } },
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(() => { throw new Error("EPERM"); }),
  }) satisfies HermesGatewayProcess;
  const client = createHermesStdioClient({ command: "hermes", args: [], cwd: "/safe", env: {},
    spawnFn: () => child, onEvent: () => undefined, onFailure: () => undefined });
  const ready = client.ready().catch(() => undefined);
  const first = client.close();
  expect(client.close()).toBe(first);
  const result = first.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await result).toBe(false);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  let confirmed = false;
  void client.whenExited().then(() => { confirmed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(confirmed).toBe(false);
  child.emit("exit", 0, null);
  await client.whenExited();
  expect(confirmed).toBe(true);
  await ready;
  expect(vi.getTimerCount()).toBe(0);
});

it("settles a definitive no-child spawn error without waiting for an impossible exit", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: { write: () => true, end: vi.fn() },
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  });
  const client = createHermesStdioClient({ command: "missing-hermes", args: [], cwd: "/safe", env: {},
    spawnFn: () => child, onEvent: () => undefined, onFailure: () => undefined });
  const ready = client.ready().catch((error: unknown) => error);
  child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  expect(await ready).toBeInstanceOf(Error);
  const closing = client.close();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await closing).toBe(true);
  await client.whenExited();
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
