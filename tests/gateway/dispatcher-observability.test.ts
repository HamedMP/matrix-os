import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createDispatcher,
  type SpawnFn,
} from "../../packages/gateway/src/dispatcher.js";
import type { KernelEvent } from "@matrix-os/kernel";
import {
  metricsRegistry,
  kernelDispatchTotal,
  kernelDispatchDuration,
  aiCostTotal,
  aiTokensTotal,
} from "../../packages/gateway/src/metrics.js";

function makeHomePath(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "dispatch-obs-")));
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

function fakeSpawn(cost = 0.01): SpawnFn {
  return async function* (_message, _config) {
    yield { type: "init", sessionId: "test-session" } as KernelEvent;
    yield { type: "text", text: "response" } as KernelEvent;
    yield { type: "tool_start", tool: "bash" } as KernelEvent;
    yield { type: "tool_end" } as KernelEvent;
    yield {
      type: "result",
      data: { sessionId: "test-session", cost, turns: 1 },
    } as KernelEvent;
  };
}

function failingSpawn(): SpawnFn {
  return async function* (_message, _config) {
    yield { type: "init", sessionId: "fail-session" } as KernelEvent;
    throw new Error("kernel crash");
  };
}

describe("T1204: Interaction logger wiring in dispatcher", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("logs interaction after successful dispatch", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawn(0.05),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hello world", "s1", () => {});

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.source).toBe("web");
    expect(entry.sessionId).toBe("test-session");
    expect(entry.prompt).toBe("hello world");
    expect(entry.costUsd).toBe(0.05);
    expect(entry.result).toBe("ok");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.toolsUsed).toContain("bash");
  });

  it("logs channel source when dispatching from a channel", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawn(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hi", undefined, () => {}, {
      channel: "telegram",
      senderId: "user1",
    });

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.source).toBe("telegram");
  });

  it("truncates long prompts in log", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawn(),
      maxConcurrency: 1,
    });

    const longMessage = "x".repeat(2000);
    await dispatcher.dispatch(longMessage, undefined, () => {});

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.prompt.length).toBeLessThan(2000);
  });

  it("logs error status on failed dispatch", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: failingSpawn(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("fail", undefined, () => {}).catch(() => {});

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.result).toBe("error");
  });

  it("logger failure does not break dispatch", async () => {
    const badHomePath = makeHomePath();
    const dispatcher = createDispatcher({
      homePath: badHomePath,
      spawnFn: fakeSpawn(),
      maxConcurrency: 1,
    });

    // Remove logs directory to cause write failure
    const { rmSync } = await import("node:fs");
    rmSync(join(badHomePath, "system", "logs"), { recursive: true });

    const events: KernelEvent[] = [];
    await dispatcher.dispatch("hello", undefined, (e) => events.push(e));

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "result")).toBe(true);
  });
});

describe("T1206: Dispatch metrics instrumentation", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = makeHomePath();
    metricsRegistry.resetMetrics();
  });

  it("increments kernelDispatchTotal on success", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawn(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hello", undefined, () => {});

    const metric = await kernelDispatchTotal.get();
    const success = metric.values.find(
      (v) => v.labels.source === "web" && v.labels.status === "ok",
    );
    expect(success?.value).toBe(1);
  });

  it("increments kernelDispatchTotal on error", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: failingSpawn(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("fail", undefined, () => {}).catch(() => {});

    const metric = await kernelDispatchTotal.get();
    const error = metric.values.find(
      (v) => v.labels.source === "web" && v.labels.status === "error",
    );
    expect(error?.value).toBe(1);
  });

  it("records kernelDispatchDuration", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawn(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hello", undefined, () => {});

    const metric = await kernelDispatchDuration.get();
    const countValue = metric.values.find(
      (v) => v.metricName === "gateway_kernel_dispatch_duration_seconds_count",
    );
    expect(countValue?.value).toBe(1);
    const sumValue = metric.values.find(
      (v) => v.metricName === "gateway_kernel_dispatch_duration_seconds_sum",
    );
    expect(sumValue?.value).toBeGreaterThanOrEqual(0);
  });

  it("uses channel as source label when dispatching from channel", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawn(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hi", undefined, () => {}, {
      channel: "telegram",
      senderId: "user1",
    });

    const metric = await kernelDispatchTotal.get();
    const telegram = metric.values.find(
      (v) => v.labels.source === "telegram" && v.labels.status === "ok",
    );
    expect(telegram?.value).toBe(1);
  });

  it("increments aiCostTotal from kernel result", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawn(0.07),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hello", undefined, () => {});

    const metric = await aiCostTotal.get();
    const values = metric.values.filter((v) => v.value > 0);
    expect(values.length).toBeGreaterThan(0);
  });
});
