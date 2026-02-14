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
  const dir = resolve(mkdtempSync(join(tmpdir(), "dispatch-b-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

function resultEvent(id: string): KernelEvent {
  return { type: "result", data: { sessionId: id, cost: 0, turns: 1 } };
}

describe("T404: Dispatcher batch mode", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("batch with single entry works", async () => {
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      yield { type: "init", sessionId: "s1" } as KernelEvent;
      yield { type: "text", text: "built app" } as KernelEvent;
      yield resultEvent("s1");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const events: KernelEvent[] = [];

    const results = await dispatcher.dispatchBatch([
      { taskId: "t1", message: "build Study Planner", onEvent: (e) => events.push(e) },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("t1");
    expect(results[0].status).toBe("fulfilled");
    expect(events.length).toBeGreaterThan(0);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("multiple entries run in parallel", async () => {
    const startTimes: number[] = [];
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      startTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, 50));
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    await dispatcher.dispatchBatch([
      { taskId: "t1", message: "build app 1", onEvent: () => {} },
      { taskId: "t2", message: "build app 2", onEvent: () => {} },
      { taskId: "t3", message: "build app 3", onEvent: () => {} },
    ]);

    expect(spawn).toHaveBeenCalledTimes(3);
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(30);
  });

  it("batch blocks serial queue", async () => {
    const order: string[] = [];
    let releaseBatch: (() => void) | null = null;

    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      if (message.startsWith("batch-")) {
        order.push(`batch-start-${message}`);
        await new Promise<void>((r) => { releaseBatch = r; });
        order.push(`batch-end-${message}`);
      } else {
        order.push(`serial-${message}`);
      }
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const batchPromise = dispatcher.dispatchBatch([
      { taskId: "t1", message: "batch-a", onEvent: () => {} },
    ]);
    const serialPromise = dispatcher.dispatch("after-batch", undefined, () => {});

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["batch-start-batch-a"]);

    releaseBatch!();
    await Promise.all([batchPromise, serialPromise]);
    expect(order).toEqual(["batch-start-batch-a", "batch-end-batch-a", "serial-after-batch"]);
  });

  it("serial dispatch blocks batch", async () => {
    const order: string[] = [];
    let releaseSerial: (() => void) | null = null;

    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      if (message === "serial-first") {
        order.push("serial-start");
        await new Promise<void>((r) => { releaseSerial = r; });
        order.push("serial-end");
      } else {
        order.push(`batch-${message}`);
      }
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn, maxConcurrency: 1 });

    const serialPromise = dispatcher.dispatch("serial-first", undefined, () => {});

    await new Promise((r) => setTimeout(r, 10));

    const batchPromise = dispatcher.dispatchBatch([
      { taskId: "t1", message: "app-1", onEvent: () => {} },
    ]);

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["serial-start"]);

    releaseSerial!();
    await Promise.all([serialPromise, batchPromise]);
    expect(order).toEqual(["serial-start", "serial-end", "batch-app-1"]);
  });

  it("partial failures return mixed results", async () => {
    let callCount = 0;
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      callCount++;
      if (callCount === 2) throw new Error("build failed");
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const results = await dispatcher.dispatchBatch([
      { taskId: "t1", message: "app 1", onEvent: () => {} },
      { taskId: "t2", message: "app 2", onEvent: () => {} },
      { taskId: "t3", message: "app 3", onEvent: () => {} },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[1].error).toBe("build failed");
    expect(results[2].status).toBe("fulfilled");
  });

  it("empty batch resolves immediately", async () => {
    const spawn = vi.fn<SpawnFn>(async function* () {
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const results = await dispatcher.dispatchBatch([]);

    expect(results).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("queue length includes batch as 1 entry", async () => {
    let releaseFirst: (() => void) | null = null;

    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      if (message === "blocking") {
        await new Promise<void>((r) => { releaseFirst = r; });
      }
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn, maxConcurrency: 1 });

    const p1 = dispatcher.dispatch("blocking", undefined, () => {});
    await new Promise((r) => setTimeout(r, 10));

    const batchPromise = dispatcher.dispatchBatch([
      { taskId: "t1", message: "app 1", onEvent: () => {} },
      { taskId: "t2", message: "app 2", onEvent: () => {} },
      { taskId: "t3", message: "app 3", onEvent: () => {} },
    ]);

    expect(dispatcher.queueLength).toBe(1);

    releaseFirst!();
    await Promise.all([p1, batchPromise]);
    expect(dispatcher.queueLength).toBe(0);
  });

  it("each batch entry gets independent events", async () => {
    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      yield { type: "text", text: `built-${message}` } as KernelEvent;
      yield resultEvent(`s-${message}`);
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const eventsA: KernelEvent[] = [];
    const eventsB: KernelEvent[] = [];

    await dispatcher.dispatchBatch([
      { taskId: "t1", message: "alpha", onEvent: (e) => eventsA.push(e) },
      { taskId: "t2", message: "beta", onEvent: (e) => eventsB.push(e) },
    ]);

    expect(eventsA.some((e) => e.type === "text" && e.text === "built-alpha")).toBe(true);
    expect(eventsB.some((e) => e.type === "text" && e.text === "built-beta")).toBe(true);
    expect(eventsA.some((e) => e.type === "text" && e.text === "built-beta")).toBe(false);
  });
});
