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
  const dir = resolve(mkdtempSync(join(tmpdir(), "dispatch-c-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

function resultEvent(id: string): KernelEvent {
  return { type: "result", data: { sessionId: id, cost: 0, turns: 1 } };
}

describe("T054: Concurrent dispatch", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("runs dispatches in parallel by default", async () => {
    const startTimes: number[] = [];
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      startTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, 50));
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    await Promise.all([
      dispatcher.dispatch("first", undefined, () => {}),
      dispatcher.dispatch("second", undefined, () => {}),
      dispatcher.dispatch("third", undefined, () => {}),
    ]);

    expect(spawn).toHaveBeenCalledTimes(3);
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(30);
  });

  it("each dispatch gets independent events", async () => {
    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      yield { type: "init", sessionId: `session-${message}` } as KernelEvent;
      yield { type: "text", text: `reply-${message}` } as KernelEvent;
      yield resultEvent(`session-${message}`);
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const eventsA: KernelEvent[] = [];
    const eventsB: KernelEvent[] = [];

    await Promise.all([
      dispatcher.dispatch("a", undefined, (e) => eventsA.push(e)),
      dispatcher.dispatch("b", undefined, (e) => eventsB.push(e)),
    ]);

    expect(eventsA.some((e) => e.type === "text" && e.text === "reply-a")).toBe(true);
    expect(eventsB.some((e) => e.type === "text" && e.text === "reply-b")).toBe(true);
    expect(eventsA.some((e) => e.type === "text" && e.text === "reply-b")).toBe(false);
  });

  it("errors in one dispatch do not affect others", async () => {
    let callCount = 0;
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      callCount++;
      if (callCount === 1) throw new Error("kernel crash");
      yield resultEvent("s2");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const results = await Promise.allSettled([
      dispatcher.dispatch("will-fail", undefined, () => {}),
      dispatcher.dispatch("will-succeed", undefined, () => {}),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });

  it("tracks active dispatch count", async () => {
    const gates: Array<() => void> = [];
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      await new Promise<void>((r) => gates.push(r));
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    expect(dispatcher.activeCount).toBe(0);

    const p1 = dispatcher.dispatch("a", undefined, () => {});
    const p2 = dispatcher.dispatch("b", undefined, () => {});

    await new Promise((r) => setTimeout(r, 10));
    expect(dispatcher.activeCount).toBe(2);

    gates.forEach((g) => g());
    await Promise.all([p1, p2]);
    expect(dispatcher.activeCount).toBe(0);
  });

  it("respects maxConcurrency limit", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;

    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      order.push(`start-${message}`);
      if (message === "a") {
        await new Promise<void>((r) => { releaseFirst = r; });
      }
      order.push(`end-${message}`);
      yield resultEvent(`s-${message}`);
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn, maxConcurrency: 1 });

    const p1 = dispatcher.dispatch("a", undefined, () => {});
    const p2 = dispatcher.dispatch("b", undefined, () => {});

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start-a"]);

    releaseFirst!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });

  it("queueLength shows items waiting behind concurrency limit", async () => {
    let releaseGate: (() => void) | null = null;
    const spawn = vi.fn<SpawnFn>(async function* (message, _config) {
      if (message === "first") {
        await new Promise<void>((r) => { releaseGate = r; });
      }
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn, maxConcurrency: 1 });
    expect(dispatcher.queueLength).toBe(0);

    const p1 = dispatcher.dispatch("first", undefined, () => {});
    await new Promise((r) => setTimeout(r, 10));

    const p2 = dispatcher.dispatch("second", undefined, () => {});
    expect(dispatcher.queueLength).toBe(1);

    releaseGate!();
    await Promise.all([p1, p2]);
    expect(dispatcher.queueLength).toBe(0);
  });
});

describe("T055: Process registration", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("registers kernel process in tasks table during dispatch", async () => {
    let releaseSpawn: (() => void) | null = null;
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      await new Promise<void>((r) => { releaseSpawn = r; });
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const p = dispatcher.dispatch("build a CRM", undefined, () => {});

    await new Promise((r) => setTimeout(r, 10));
    const { listTasks } = await import("../../packages/kernel/src/ipc.js");
    const active = listTasks(dispatcher.db, { status: "in_progress" })
      .filter((t) => t.type === "kernel");
    expect(active.length).toBe(1);
    expect(JSON.parse(active[0].input)).toHaveProperty("message", "build a CRM");

    releaseSpawn!();
    await p;
  });

  it("marks process completed after successful dispatch", async () => {
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    await dispatcher.dispatch("test", undefined, () => {});

    const { listTasks } = await import("../../packages/kernel/src/ipc.js");
    const active = listTasks(dispatcher.db, { status: "in_progress" })
      .filter((t) => t.type === "kernel");
    expect(active.length).toBe(0);

    const completed = listTasks(dispatcher.db, { status: "completed" })
      .filter((t) => t.type === "kernel");
    expect(completed.length).toBe(1);
  });

  it("marks process failed on dispatch error", async () => {
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      throw new Error("kernel crash");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    await dispatcher.dispatch("test", undefined, () => {}).catch(() => {});

    const { listTasks } = await import("../../packages/kernel/src/ipc.js");
    const failed = listTasks(dispatcher.db, { status: "failed" })
      .filter((t) => t.type === "kernel");
    expect(failed.length).toBe(1);
  });

  it("multiple concurrent processes are all registered", async () => {
    const gates: Array<() => void> = [];
    const spawn = vi.fn<SpawnFn>(async function* (_message, _config) {
      await new Promise<void>((r) => gates.push(r));
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const p1 = dispatcher.dispatch("task-1", undefined, () => {});
    const p2 = dispatcher.dispatch("task-2", undefined, () => {});
    const p3 = dispatcher.dispatch("task-3", undefined, () => {});

    await new Promise((r) => setTimeout(r, 20));
    const { listTasks } = await import("../../packages/kernel/src/ipc.js");
    const active = listTasks(dispatcher.db, { status: "in_progress" })
      .filter((t) => t.type === "kernel");
    expect(active.length).toBe(3);

    gates.forEach((g) => g());
    await Promise.all([p1, p2, p3]);
  });
});
