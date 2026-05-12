import { describe, expect, it, vi } from "vitest";
import { createSymphonyRoutes } from "../../packages/gateway/src/symphony-routes.js";
import { SymphonyConfigLoadError } from "../../packages/gateway/src/symphony-runner.js";

const config = {
  version: 1 as const,
  serviceRoot: "/home/matrixos/code/symphony/elixir",
  binPath: "./bin/symphony",
  workflowPath: "/app/WORKFLOW.md",
  port: 4066,
  tracker: {
    kind: "linear" as const,
    teamKey: "MAT",
    requiredLabels: ["symphony"],
    activeStates: ["Todo", "In Progress", "Merging", "Rework"],
  },
};

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Symphony routes", () => {
  it("returns local runner status", async () => {
    const runner = {
      status: vi.fn(async () => ({
        running: false,
        pid: null,
        startedAt: null,
        lastExitAt: null,
        lastExitCode: null,
        dashboardUrl: "http://127.0.0.1:4066",
        linearApiKeyConfigured: true,
        config,
      })),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner });

    const res = await app.request("/status");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      running: false,
      dashboardUrl: "http://127.0.0.1:4066",
      config: { tracker: { teamKey: "MAT", requiredLabels: ["symphony"] } },
    });
  });

  it("returns a structured config error when status cannot load config", async () => {
    const runner = {
      status: vi.fn(async () => {
        throw new SymphonyConfigLoadError();
      }),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner });

    const res = await app.request("/status");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "config_load_error",
        message: "Symphony configuration could not be loaded",
      },
    });
  });

  it("returns a structured config error when config cannot load config", async () => {
    const runner = {
      status: vi.fn(),
      getConfig: vi.fn(async () => {
        throw new SymphonyConfigLoadError();
      }),
      saveConfig: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner });

    const res = await app.request("/config");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "config_load_error",
        message: "Symphony configuration could not be loaded",
      },
    });
  });

  it("validates start payloads before invoking the runner", async () => {
    const runner = {
      status: vi.fn(),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner });

    const res = await app.request(jsonRequest("/start", { port: 80 }));

    expect(res.status).toBe(400);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("rejects oversized start payloads before invoking the runner", async () => {
    const runner = {
      status: vi.fn(),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner });

    const res = await app.request(jsonRequest("/start", { serviceRoot: "x".repeat(20_000) }));

    expect(res.status).toBe(413);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("starts with Matrix's Linear ticket filter contract", async () => {
    const onConfigChange = vi.fn();
    const runner = {
      status: vi.fn(),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      start: vi.fn(async () => ({
        ok: true as const,
        status: {
          running: true,
          pid: 123,
          startedAt: "2026-05-10T00:00:00.000Z",
          lastExitAt: null,
          lastExitCode: null,
          dashboardUrl: "http://127.0.0.1:4066",
          linearApiKeyConfigured: true,
          config,
        },
      })),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner, onConfigChange });

    const res = await app.request(jsonRequest("/start", {
      tracker: {
        teamKey: "MAT",
        requiredLabels: ["symphony"],
        activeStates: ["Todo", "In Progress", "Merging", "Rework"],
      },
    }));

    expect(res.status).toBe(200);
    expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({
      tracker: {
        teamKey: "MAT",
        requiredLabels: ["symphony"],
        activeStates: ["Todo", "In Progress", "Merging", "Rework"],
      },
    }));
    expect(onConfigChange).toHaveBeenCalledWith({ port: 4066 });
  });

  it("notifies when runtime config changes", async () => {
    const onConfigChange = vi.fn();
    const nextConfig = { ...config, port: 4088 };
    const runner = {
      status: vi.fn(),
      getConfig: vi.fn(),
      saveConfig: vi.fn(async () => nextConfig),
      start: vi.fn(),
      stop: vi.fn(),
    };
    runner.status.mockResolvedValue({
      running: false,
      pid: null,
      startedAt: null,
      lastExitAt: null,
      lastExitCode: null,
      dashboardUrl: "http://127.0.0.1:4088",
      linearApiKeyConfigured: true,
      config: nextConfig,
    });
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner, onConfigChange });

    const res = await app.request(jsonRequest("/config", { port: 4088 }));

    expect(res.status).toBe(200);
    expect(runner.saveConfig).toHaveBeenCalledWith({ port: 4088 });
    expect(onConfigChange).toHaveBeenCalledWith({ port: 4088, runningPort: undefined });
  });

  it("keeps the launched runner port allowed when config changes while running", async () => {
    const onConfigChange = vi.fn();
    const savedConfig = { ...config, port: 4088 };
    const runningConfig = { ...config, port: 4077 };
    const runner = {
      status: vi.fn(async () => ({
        running: true,
        pid: 123,
        startedAt: "2026-05-10T00:00:00.000Z",
        lastExitAt: null,
        lastExitCode: null,
        dashboardUrl: "http://127.0.0.1:4077",
        linearApiKeyConfigured: true,
        config: runningConfig,
      })),
      getConfig: vi.fn(),
      saveConfig: vi.fn(async () => savedConfig),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner, onConfigChange });

    const res = await app.request(jsonRequest("/config", { port: 4088 }));

    expect(res.status).toBe(200);
    expect(onConfigChange).toHaveBeenCalledWith({ port: 4088, runningPort: 4077 });
  });

  it("rejects stop request bodies before stopping", async () => {
    const runner = {
      status: vi.fn(),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = createSymphonyRoutes({ homePath: "/tmp/matrix", runner });

    const res = await app.request(jsonRequest("/stop", { force: true }));

    expect(res.status).toBe(400);
    expect(runner.stop).not.toHaveBeenCalled();
  });
});
