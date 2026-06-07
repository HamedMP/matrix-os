import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CleanupCandidateRegistry, executeCleanupAction } from "../../packages/gateway/src/system-activity/cleanup.js";
import { ActivityHistoryStore } from "../../packages/gateway/src/system-activity/history.js";
import type { ProcessSummary } from "../../packages/gateway/src/system-activity/types.js";
import { classifyProcess, deriveMachineStatus, parseSocketConnectionCounts } from "../../packages/gateway/src/system-activity/collector.js";

function process(overrides: Partial<ProcessSummary> = {}): ProcessSummary {
  return {
    processRef: "proc_100",
    pid: 100,
    ownerClass: "matrix",
    classification: "app_server",
    displayName: "Next.js app server",
    cpuPercent: 0,
    rssBytes: 50_000_000,
    elapsedSeconds: 31 * 24 * 60 * 60,
    ports: [45679],
    activeConnections: 0,
    ...overrides,
  };
}

describe("system activity cleanup", () => {
  it("classifies stale inactive app servers and issues confirmation tokens", () => {
    const registry = new CleanupCandidateRegistry({ ttlMs: 1_000, maxCandidates: 10 });

    const suggestions = registry.classify([process()], 1000);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      type: "stop_stale_app_server",
      confidence: "high",
      risk: "low",
      requiresConfirmation: true,
    });
    expect(suggestions[0].confirmationToken).toMatch(/^confirm_/);
  });

  it("skips active and young app servers", () => {
    const registry = new CleanupCandidateRegistry();

    expect(registry.classify([
      process({ activeConnections: 2 }),
      process({ elapsedSeconds: 300 }),
      process({ activeConnections: undefined }),
    ])).toEqual([]);
  });

  it("uses caller-provided grace period for stale app server suggestions", () => {
    const registry = new CleanupCandidateRegistry();

    expect(registry.classify([process({ elapsedSeconds: 3600 })])).toEqual([]);
    expect(registry.classify([process({ elapsedSeconds: 3600 })], Date.now(), { minElapsedSeconds: 300 })).toHaveLength(1);
  });

  it("parses active socket counts by pid for app server safety checks", () => {
    const counts = parseSocketConnectionCounts([
      "ESTAB 0 0 127.0.0.1:45679 127.0.0.1:53000 users:((\"next-server\",pid=123,fd=20))",
      "ESTAB 0 0 127.0.0.1:45679 127.0.0.1:53001 users:((\"next-server\",pid=123,fd=21))",
      "ESTAB 0 0 127.0.0.1:45680 127.0.0.1:53002 users:((\"vite\",pid=456,fd=9))",
    ].join("\n"));

    expect(counts.get(123)).toBe(2);
    expect(counts.get(456)).toBe(1);
  });

  it("does not classify vitest watch processes as vite app servers", () => {
    expect(classifyProcess("vitest", "vitest --watch")).toBe("unknown");
    expect(classifyProcess("node", "vite --host 0.0.0.0")).toBe("app_server");
  });

  it("derives degraded machine status from failed services and pressure", () => {
    expect(deriveMachineStatus({
      load1: 0.2,
      pressureSome10: 0,
      cpuCores: 2,
      services: [{ serviceId: "matrix-gateway", state: "failed" }],
    })).toBe("degraded");
    expect(deriveMachineStatus({
      load1: 0.2,
      pressureSome10: 25,
      cpuCores: 2,
      services: [{ serviceId: "matrix-gateway", state: "running" }],
    })).toBe("degraded");
  });

  it("expires candidates and enforces max cache size", () => {
    const registry = new CleanupCandidateRegistry({ ttlMs: 1_000, maxCandidates: 2 });

    registry.classify([process({ pid: 1 }), process({ pid: 2 }), process({ pid: 3 })], 1000);
    expect(registry.size(1000)).toBe(2);

    registry.classify([], 2500);
    expect(registry.size(2500)).toBe(0);
  });

  it("executes only server-issued candidates and records history", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "activity-cleanup-"));
    try {
      const registry = new CleanupCandidateRegistry();
      const [candidate] = registry.classify([process({ pid: 123 })], Date.now());
      const killProcess = vi.fn();

      const result = await executeCleanupAction({
        action: {
          type: candidate.type,
          candidateId: candidate.candidateId,
          confirmationToken: candidate.confirmationToken,
          mode: "manual",
        },
        registry,
        history: new ActivityHistoryStore({ homePath }),
        killProcess,
      });

      expect(result.result).toBe("completed");
      expect(killProcess).toHaveBeenCalledWith(123, 0);
      expect(killProcess).toHaveBeenCalledWith(123, "SIGTERM");
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("records permission failures in cleanup history", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "activity-cleanup-"));
    try {
      const registry = new CleanupCandidateRegistry();
      const [candidate] = registry.classify([process({ pid: 123 })], Date.now());
      const permissionError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      const killProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === "SIGTERM") throw permissionError;
      });
      const history = new ActivityHistoryStore({ homePath });

      const result = await executeCleanupAction({
        action: {
          type: candidate.type,
          candidateId: candidate.candidateId,
          confirmationToken: candidate.confirmationToken,
          mode: "manual",
        },
        registry,
        history,
        killProcess,
      });

      expect(result.result).toBe("failed");
      const page = await history.list({ limit: 1 });
      expect(page.entries[0]).toMatchObject({
        result: "failed",
        actionType: "stop_stale_app_server",
      });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
