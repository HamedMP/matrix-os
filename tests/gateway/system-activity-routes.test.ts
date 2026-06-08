import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createSystemActivityRoutes } from "../../packages/gateway/src/system-activity/routes.js";
import { ActivityConflictError, type ActivitySnapshot, type CleanupCandidate } from "../../packages/gateway/src/system-activity/types.js";

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    generatedAt: "2026-06-07T17:30:00.000Z",
    machine: {
      handle: "hamedmp",
      runtimeSlot: "primary",
      hostname: "matrix-hamedmp-bdbdbbb5",
      status: "healthy",
      releaseVersion: "v2026.06.07-316",
      releaseChannel: "dev",
      gitCommit: "e7e2ef8",
      uptimeSeconds: 123,
    },
    resources: {
      cpu: { cores: 2, load1: 0.5, load5: 0.2, load15: 0.1, pressureSome10: 0 },
      memory: {
        totalBytes: 4_000_000_000,
        usedBytes: 2_000_000_000,
        availableBytes: 2_000_000_000,
        processRssBytes: 1_000_000_000,
        cgroupAnonBytes: 0,
        cgroupFileBytes: 0,
        cgroupKernelBytes: 0,
      },
      swap: { totalBytes: 0, usedBytes: 0 },
      disk: [{ mount: "/", label: "System", usedBytes: 10, totalBytes: 100, usedPercent: 10 }],
    },
    services: [],
    processes: [],
    cleanupSuggestions: [],
    collectionWarnings: [],
    ...overrides,
  };
}

function appWith(deps: Parameters<typeof createSystemActivityRoutes>[0]) {
  const app = new Hono();
  app.route("/api/system", createSystemActivityRoutes(deps));
  return app;
}

describe("system activity routes", () => {
  it("returns a bounded system activity snapshot with cleanup suggestions", async () => {
    const candidate: CleanupCandidate = {
      candidateId: "cand_1",
      type: "stop_stale_app_server",
      targetLabel: "matrix-beta-crm preview server",
      reason: "No active connections and executable no longer matches the current runtime.",
      confidence: "high",
      risk: "low",
      estimatedReclaimBytes: 104_857_600,
      requiresConfirmation: true,
      confirmationToken: "confirm_1",
      expiresAt: "2026-06-07T17:35:00.000Z",
    };
    const collect = vi.fn(async () => snapshot({ cleanupSuggestions: [candidate] }));
    const app = appWith({ collect });

    const res = await app.request("/api/system/activity?processLimit=10&includeSuggestions=true");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      machine: { handle: "hamedmp", releaseVersion: "v2026.06.07-316" },
      cleanupSuggestions: [{ candidateId: "cand_1", confirmationToken: "confirm_1" }],
    });
    expect(collect).toHaveBeenCalledWith({ processLimit: 10, includeSuggestions: true });
  });

  it("validates activity query params before collection", async () => {
    const collect = vi.fn(async () => snapshot());
    const app = appWith({ collect });

    const res = await app.request("/api/system/activity?processLimit=999");

    expect(res.status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("parses includeSuggestions=false as false", async () => {
    const collect = vi.fn(async () => snapshot());
    const app = appWith({ collect });

    const res = await app.request("/api/system/activity?includeSuggestions=false");

    expect(res.status).toBe(200);
    expect(collect).toHaveBeenCalledWith({ processLimit: 25, includeSuggestions: false });
  });

  it("uses generic client errors for collector failures", async () => {
    const collect = vi.fn(async () => {
      throw new Error("systemctl raw failure /opt/matrix/secret");
    });
    const app = appWith({ collect });

    const res = await app.request("/api/system/activity");

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: { code: "collection_failed", message: "Request failed" },
    });
  });

  it("executes a typed cleanup action with confirmation and writes history", async () => {
    const executeAction = vi.fn(async () => ({
      actionId: "act_1",
      result: "completed" as const,
      reclaimedBytes: 100,
      message: "Cleanup completed.",
      snapshotRefreshRecommended: true,
    }));
    const app = appWith({ collect: vi.fn(async () => snapshot()), executeAction });

    const res = await app.request("/api/system/activity/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stop_stale_app_server",
        candidateId: "cand_1",
        confirmationToken: "confirm_1",
        mode: "manual",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      actionId: "act_1",
      result: "completed",
      snapshotRefreshRecommended: true,
    });
    expect(executeAction).toHaveBeenCalledWith({
      type: "stop_stale_app_server",
      candidateId: "cand_1",
      confirmationToken: "confirm_1",
      mode: "manual",
    });
  });

  it("rejects oversized cleanup action bodies before JSON parsing", async () => {
    const executeAction = vi.fn();
    const app = appWith({ collect: vi.fn(async () => snapshot()), executeAction });

    const res = await app.request("/api/system/activity/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "20000" },
      body: JSON.stringify({ payload: "x".repeat(20_000) }),
    });

    expect(res.status).toBe(413);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("maps candidate mismatches to a sanitized conflict", async () => {
    const executeAction = vi.fn(async () => {
      throw new ActivityConflictError("raw pid mismatch");
    });
    const app = appWith({ collect: vi.fn(async () => snapshot()), executeAction });

    const res = await app.request("/api/system/activity/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stop_stale_app_server",
        candidateId: "cand_1",
        confirmationToken: "wrong",
        mode: "manual",
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: { code: "candidate_conflict", message: "Cleanup target changed" },
    });
  });

  it("requires enabled policy allowlist for automatic cleanup actions", async () => {
    const executeAction = vi.fn(async () => ({
      actionId: "act_1",
      result: "completed" as const,
      message: "Cleanup completed.",
      snapshotRefreshRecommended: true,
    }));
    const app = appWith({
      collect: vi.fn(async () => snapshot()),
      executeAction,
      readPolicy: vi.fn(async () => ({
        enabled: false,
        allowedTypes: ["stop_stale_app_server"],
        gracePeriodSeconds: 1800,
        maxActionsPerHour: 3,
        lastUpdatedAt: "2026-06-07T17:30:00.000Z",
      })),
    });

    const res = await app.request("/api/system/activity/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stop_stale_app_server",
        candidateId: "cand_1",
        confirmationToken: "confirm_1",
        mode: "automatic",
      }),
    });

    expect(res.status).toBe(403);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("enforces the automatic cleanup hourly action budget", async () => {
    const executeAction = vi.fn(async () => ({
      actionId: "act_1",
      result: "completed" as const,
      message: "Cleanup completed.",
      snapshotRefreshRecommended: true,
    }));
    const app = appWith({
      collect: vi.fn(async () => snapshot()),
      executeAction,
      readPolicy: vi.fn(async () => ({
        enabled: true,
        allowedTypes: ["stop_stale_app_server"],
        gracePeriodSeconds: 1800,
        maxActionsPerHour: 1,
        lastUpdatedAt: "2026-06-07T17:30:00.000Z",
      })),
      readHistory: vi.fn(async () => ({
        entries: [{
          id: "hist_1",
          createdAt: new Date().toISOString(),
          actor: "auto_policy" as const,
          actionType: "stop_stale_app_server" as const,
          targetLabel: "preview server",
          result: "completed" as const,
          reasonCode: "stale_app_server_no_connections",
        }],
        nextCursor: null,
      })),
    });

    const res = await app.request("/api/system/activity/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stop_stale_app_server",
        candidateId: "cand_1",
        confirmationToken: "confirm_1",
        mode: "automatic",
      }),
    });

    expect(res.status).toBe(403);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("reserves automatic cleanup budget across concurrent requests", async () => {
    const executeAction = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        actionId: "act_1",
        result: "completed" as const,
        message: "Cleanup completed.",
        snapshotRefreshRecommended: true,
      };
    });
    const app = appWith({
      collect: vi.fn(async () => snapshot()),
      executeAction,
      readPolicy: vi.fn(async () => ({
        enabled: true,
        allowedTypes: ["stop_stale_app_server"],
        gracePeriodSeconds: 1800,
        maxActionsPerHour: 1,
        lastUpdatedAt: "2026-06-07T17:30:00.000Z",
      })),
      readHistory: vi.fn(async () => ({ entries: [], nextCursor: null })),
    });
    const request = () => app.request("/api/system/activity/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stop_stale_app_server",
        candidateId: "cand_1",
        confirmationToken: "confirm_1",
        mode: "automatic",
      }),
    });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((res) => res.status).sort()).toEqual([200, 403]);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it("releases automatic cleanup budget after successful execution", async () => {
    const executeAction = vi.fn(async () => ({
      actionId: "act_1",
      result: "completed" as const,
      message: "Cleanup completed.",
      snapshotRefreshRecommended: true,
    }));
    const app = appWith({
      collect: vi.fn(async () => snapshot()),
      executeAction,
      readPolicy: vi.fn(async () => ({
        enabled: true,
        allowedTypes: ["stop_stale_app_server"],
        gracePeriodSeconds: 1800,
        maxActionsPerHour: 1,
        lastUpdatedAt: "2026-06-07T17:30:00.000Z",
      })),
      readHistory: vi.fn(async () => ({ entries: [], nextCursor: null })),
    });
    const request = () => app.request("/api/system/activity/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stop_stale_app_server",
        candidateId: "cand_1",
        confirmationToken: "confirm_1",
        mode: "automatic",
      }),
    });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(executeAction).toHaveBeenCalledTimes(2);
  });

  it("reads and updates auto-clean policy with a conservative allowlist", async () => {
    const readPolicy = vi.fn(async () => ({
      enabled: false,
      allowedTypes: [],
      gracePeriodSeconds: 1800,
      maxActionsPerHour: 3,
      lastUpdatedAt: "2026-06-07T17:30:00.000Z",
    }));
    const savePolicy = vi.fn(async (policy) => ({
      ...policy,
      lastUpdatedAt: "2026-06-07T17:31:00.000Z",
    }));
    const app = appWith({ collect: vi.fn(async () => snapshot()), readPolicy, savePolicy });

    expect((await app.request("/api/system/activity/policy")).status).toBe(200);
    const saved = await app.request("/api/system/activity/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        allowedTypes: ["stop_stale_app_server", "restart_idle_code_server"],
        gracePeriodSeconds: 3600,
        maxActionsPerHour: 2,
      }),
    });

    expect(saved.status).toBe(400);
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("returns bounded cleanup history", async () => {
    const readHistory = vi.fn(async () => ({
      entries: [
        {
          id: "hist_1",
          createdAt: "2026-06-07T17:31:00.000Z",
          actor: "owner" as const,
          actionType: "stop_stale_app_server" as const,
          targetLabel: "preview server",
          result: "completed" as const,
          reclaimedBytes: 100,
          reasonCode: "stale_app_server_no_connections",
        },
      ],
      nextCursor: null,
    }));
    const app = appWith({ collect: vi.fn(async () => snapshot()), readHistory });

    const res = await app.request("/api/system/activity/history?limit=1");

    expect(res.status).toBe(200);
    expect(readHistory).toHaveBeenCalledWith({ limit: 1, cursor: undefined });
    await expect(res.json()).resolves.toMatchObject({ entries: [{ id: "hist_1" }] });
  });
});
