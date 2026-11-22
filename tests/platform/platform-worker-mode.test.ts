import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWorkerHealthApp, platformRole, shouldEnablePlatformBackgroundWorkers } from "../../packages/platform/src/platform-worker-mode.js";

describe("platform background worker mode", () => {
  it("requires an explicit opt-in on Cloud Run", () => {
    expect(shouldEnablePlatformBackgroundWorkers({ K_SERVICE: "matrix-platform" })).toBe(false);
    expect(shouldEnablePlatformBackgroundWorkers({ PLATFORM_RUNTIME_MODE: "cloud_run" })).toBe(false);
    expect(shouldEnablePlatformBackgroundWorkers({ K_SERVICE: "matrix-platform-worker", PLATFORM_BACKGROUND_WORKERS_ENABLED: "true" })).toBe(true);
  });

  it("preserves local platform workers unless explicitly disabled", () => {
    expect(shouldEnablePlatformBackgroundWorkers({})).toBe(true);
    expect(shouldEnablePlatformBackgroundWorkers({ PLATFORM_BACKGROUND_WORKERS_ENABLED: "false" })).toBe(false);
  });

  it("a worker-role replica runs the background workers; the web role keeps them off on Cloud Run", () => {
    expect(platformRole({})).toBe("web");
    expect(platformRole({ PLATFORM_ROLE: "worker" })).toBe("worker");
    expect(() => platformRole({ PLATFORM_ROLE: "admin" })).toThrow();
    expect(shouldEnablePlatformBackgroundWorkers({ K_SERVICE: "matrix-platform-preview-worker", PLATFORM_ROLE: "worker" })).toBe(true);
    expect(shouldEnablePlatformBackgroundWorkers({ K_SERVICE: "matrix-platform-preview", PLATFORM_ROLE: "web" })).toBe(false);
    expect(shouldEnablePlatformBackgroundWorkers({ PLATFORM_RUNTIME_MODE: "cloud_run", PLATFORM_ROLE: "worker" })).toBe(true);
  });

  it("a worker-role replica serves only its health endpoint", async () => {
    const app = createWorkerHealthApp();
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", role: "worker" });
    for (const path of ["/", "/api/journey", "/internal/containers/alice/sync/system/exists", "/vps/register"]) {
      const res = await app.request(path, { method: path === "/vps/register" ? "POST" : "GET" });
      expect(res.status, path).toBe(404);
    }
  });

  it("startup serves the health-only app for the worker role and the full app otherwise", () => {
    const source = readFileSync("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("const fetchHandler = role === 'worker' ? createWorkerHealthApp().fetch : app.fetch;");
    expect(source).toContain("serve({ fetch: fetchHandler,");
  });
});
