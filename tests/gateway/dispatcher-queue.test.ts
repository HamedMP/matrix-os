import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createDispatcher,
  type SpawnFn,
} from "../../packages/gateway/src/dispatcher.js";
import type { KernelEvent } from "@matrix-os/kernel";

function makeHomePath(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "dispatch-q-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

function fakeSpawn(): SpawnFn {
  return async function* (_message, _config) {
    yield { type: "init", sessionId: "test-session" } as KernelEvent;
    yield { type: "text", text: "response" } as KernelEvent;
    yield {
      type: "result",
      data: { sessionId: "test-session", cost: 0.01, turns: 1 },
    } as KernelEvent;
  };
}

describe("T053: Serial dispatch queue", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("processes a single dispatch normally", async () => {
    const spawn = vi.fn(fakeSpawn());
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const events: KernelEvent[] = [];

    await dispatcher.dispatch("hello", undefined, (e) => events.push(e));

    expect(events.length).toBeGreaterThan(0);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("serializes concurrent dispatches -- second waits for first", async () => {
    const executionOrder: number[] = [];
    let resolveFirst: (() => void) | null = null;

    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      if (message === "first") {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
        executionOrder.push(1);
        yield {
          type: "result",
          data: { sessionId: "s1", cost: 0, turns: 1 },
        } as KernelEvent;
      } else {
        executionOrder.push(2);
        yield {
          type: "result",
          data: { sessionId: "s2", cost: 0, turns: 1 },
        } as KernelEvent;
      }
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const p1 = dispatcher.dispatch("first", undefined, () => {});
    const p2 = dispatcher.dispatch("second", undefined, () => {});

    // Give the event loop a tick so processQueue starts the first entry
    await new Promise((r) => setTimeout(r, 10));

    // Only the first kernel should be running
    expect(spawn).toHaveBeenCalledTimes(1);

    // Release the first
    resolveFirst!();
    await Promise.all([p1, p2]);

    // Both ran, in order
    expect(executionOrder).toEqual([1, 2]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("drains queue in FIFO order", async () => {
    const executionOrder: string[] = [];
    let releaseGate: (() => void) | null = null;

    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      if (message === "a") {
        await new Promise<void>((r) => {
          releaseGate = r;
        });
      }
      executionOrder.push(message);
      yield {
        type: "result",
        data: { sessionId: `s-${message}`, cost: 0, turns: 1 },
      } as KernelEvent;
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const p1 = dispatcher.dispatch("a", undefined, () => {});
    const p2 = dispatcher.dispatch("b", undefined, () => {});
    const p3 = dispatcher.dispatch("c", undefined, () => {});

    // Give the event loop a tick so processQueue starts "a"
    await new Promise((r) => setTimeout(r, 10));

    releaseGate!();
    await Promise.all([p1, p2, p3]);

    expect(executionOrder).toEqual(["a", "b", "c"]);
  });

  it("errors in one dispatch do not block the queue", async () => {
    let callCount = 0;
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      callCount++;
      if (callCount === 1) {
        throw new Error("kernel crash");
      }
      yield {
        type: "result",
        data: { sessionId: "s2", cost: 0, turns: 1 },
      } as KernelEvent;
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const p1 = dispatcher.dispatch("will-fail", undefined, () => {});
    const p2 = dispatcher.dispatch("will-succeed", undefined, () => {});

    await expect(p1).rejects.toThrow("kernel crash");
    await expect(p2).resolves.toBeUndefined();
  });

  it("reports queue length", async () => {
    let releaseGate: (() => void) | null = null;

    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      if (message === "first") {
        await new Promise<void>((r) => {
          releaseGate = r;
        });
      }
      yield {
        type: "result",
        data: { sessionId: "s1", cost: 0, turns: 1 },
      } as KernelEvent;
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    expect(dispatcher.queueLength).toBe(0);

    const p1 = dispatcher.dispatch("first", undefined, () => {});

    // Give the event loop a tick so first dispatch starts processing
    await new Promise((r) => setTimeout(r, 10));

    // Second goes into the queue while first is running
    const p2 = dispatcher.dispatch("second", undefined, () => {});
    expect(dispatcher.queueLength).toBe(1);

    releaseGate!();
    await Promise.all([p1, p2]);

    expect(dispatcher.queueLength).toBe(0);
  });
});
