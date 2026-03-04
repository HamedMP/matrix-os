import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createDispatcher,
  type SpawnFn,
} from "../../packages/gateway/src/dispatcher.js";
import type { KernelEvent } from "@matrix-os/kernel";
import { createUsageTracker } from "../../packages/kernel/src/usage.js";

function makeHomePath(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "usage-tr-")));
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

function fakeSpawnWithCost(cost = 0.05): SpawnFn {
  return async function* (_message, _config) {
    yield { type: "init", sessionId: "test-session" } as KernelEvent;
    yield { type: "text", text: "response" } as KernelEvent;
    yield {
      type: "result",
      data: { sessionId: "test-session", cost, turns: 1, tokensIn: 1000, tokensOut: 200 },
    } as KernelEvent;
  };
}

describe("T1360: Usage tracker wired into dispatcher", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("records usage after dispatch completion", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithCost(0.07),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hello", "s1", () => {});

    const tracker = createUsageTracker(homePath);
    const daily = tracker.getDaily();
    expect(daily.total).toBeCloseTo(0.07);
    expect(daily.byAction.dispatch).toBeCloseTo(0.07);
  });

  it("accumulates cost across multiple dispatches", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithCost(0.03),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("msg1", "s1", () => {});
    await dispatcher.dispatch("msg2", "s2", () => {});

    const tracker = createUsageTracker(homePath);
    const daily = tracker.getDaily();
    expect(daily.total).toBeCloseTo(0.06);
  });

  it("includes senderId in usage metadata when available", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithCost(0.05),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hi", undefined, () => {}, {
      senderId: "user42",
    });

    const usagePath = join(homePath, "system", "logs", "usage.jsonl");
    expect(existsSync(usagePath)).toBe(true);
    const lines = readFileSync(usagePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.metadata.senderId).toBe("user42");
  });

  it("does not record usage for zero-cost dispatches", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithCost(0),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hello", "s1", () => {});

    const usagePath = join(homePath, "system", "logs", "usage.jsonl");
    if (existsSync(usagePath)) {
      const content = readFileSync(usagePath, "utf-8").trim();
      expect(content).toBe("");
    }
  });

  it("records usage for batch dispatches", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithCost(0.04),
      maxConcurrency: 1,
    });

    await dispatcher.dispatchBatch([
      { taskId: "t1", message: "build1", onEvent: () => {} },
      { taskId: "t2", message: "build2", onEvent: () => {} },
    ]);

    const tracker = createUsageTracker(homePath);
    const daily = tracker.getDaily();
    expect(daily.total).toBeCloseTo(0.08);
  });
});

describe("T1362: Per-user cost limits", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("checkLimit returns allowed when no limits configured", () => {
    const tracker = createUsageTracker(homePath);
    const result = tracker.checkLimit("dispatch");
    expect(result.allowed).toBe(true);
  });

  it("checkLimit returns not allowed when daily limit exceeded", () => {
    const tracker = createUsageTracker(homePath);
    for (let i = 0; i < 10; i++) {
      tracker.track("dispatch", 0.10);
    }
    const result = tracker.checkLimit("dispatch", { dailyLimit: 0.50 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("checkLimit returns allowed within daily limit", () => {
    const tracker = createUsageTracker(homePath);
    tracker.track("dispatch", 0.10);
    const result = tracker.checkLimit("dispatch", { dailyLimit: 1.0 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeCloseTo(0.90);
  });
});
