import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createHermesStdioClient } from "../../packages/gateway/src/chat/hermes-stdio-client";

afterEach(() => vi.useRealTimers());

function fixture() {
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  const onFailure = vi.fn();
  const client = createHermesStdioClient({ command: "fixture", args: [], cwd: "/safe", env: {},
    spawnFn: () => child, onEvent: () => undefined, onFailure });
  const ready = client.ready().catch((error: unknown) => error);
  return { stdin, child, client, ready, onFailure };
}

it.each([false, true])("settles every pending request once on asynchronous stdin failure (ready=%s)", async readyFirst => {
  vi.useFakeTimers();
  const f = fixture();
  if (readyFirst) {
    f.child.stdout.emit("data", Buffer.from(JSON.stringify({
      jsonrpc: "2.0", method: "event", params: { type: "gateway.ready" },
    }) + "\n"));
    await f.ready;
  }
  const first = f.client.request("session.create", {}).catch((error: unknown) => error);
  const second = f.client.request("prompt.submit", {}).catch((error: unknown) => error);
  const failure = Object.assign(new Error("synthetic private pipe detail"), { code: "EPIPE" });
  try {
    expect(() => f.stdin.emit("error", failure)).not.toThrow();
    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).not.toContain("private pipe detail");
    }
    if (!readyFirst) expect(await f.ready).toBeInstanceOf(Error);
    await expect(f.client.request("late", {})).rejects.toThrow();
    expect(() => f.stdin.emit("error", failure)).not.toThrow();
    f.child.emit("exit", 1, null);
    expect(f.onFailure).toHaveBeenCalledTimes(1);
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.child.emit("exit", 1, null);
    await f.client.close();
    await Promise.all([first, second, f.ready]);
    f.stdin.destroy();
  }
});

it("retains stdin error handling during and after bounded close without reporting a new Run failure", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const closing = f.client.close();
  try {
    expect(() => f.stdin.emit("error", new Error("EPIPE during close"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await closing).toBe(false);
    expect(() => f.stdin.emit("error", new Error("EPIPE after close"))).not.toThrow();
    expect(f.onFailure).not.toHaveBeenCalled();
    f.child.emit("exit", 0, null);
    await f.client.whenExited();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.child.emit("exit", 0, null);
    await closing;
    await f.ready;
    f.stdin.destroy();
  }
});
