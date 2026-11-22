import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createWorkerHealthApp, platformRole, platformWorkerScope, refuseAllWebSocketUpgrades,
  shouldEnableMetalBackgroundWorkers, shouldEnablePlatformBackgroundWorkers,
} from "../../packages/platform/src/platform-worker-mode.js";

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

  it("startup serves the health-only app and refuses WebSocket upgrades for the worker role", () => {
    const source = readFileSync("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("const fetchHandler = role === 'worker' ? createWorkerHealthApp().fetch : app.fetch;");
    expect(source).toContain("serve({ fetch: fetchHandler,");
    expect(source).toMatch(/if \(role === 'worker'\) \{\s*refuseAllWebSocketUpgrades\(server as Server\);\s*\} else \{\s*registerPlatformWebSocketUpgradeHandler\(/);
    // The metal passes follow the metal gate; every other worker follows the general one.
    expect(source).toContain("backgroundWorkersEnabled: metalWorkersEnabled, substrates: substrateRegistry");
  });

  it("refuses every WebSocket upgrade on a worker replica", async () => {
    const server = createServer((_req, res) => { res.end("ok"); });
    refuseAllWebSocketUpgrades(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/ws/terminal/tab", headers: {
          connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        } });
        req.on("upgrade", () => resolve(101));
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("a metal-scoped worker runs only the metal passes; an all-scoped worker runs everything", () => {
    expect(platformWorkerScope({})).toBe("all");
    expect(platformWorkerScope({ PLATFORM_WORKER_SCOPE: "metal" })).toBe("metal");
    expect(() => platformWorkerScope({ PLATFORM_WORKER_SCOPE: "billing" })).toThrow();
    const metal = { K_SERVICE: "matrix-platform-preview-worker-pr1", PLATFORM_ROLE: "worker", PLATFORM_WORKER_SCOPE: "metal" };
    expect(shouldEnablePlatformBackgroundWorkers(metal)).toBe(false);
    expect(shouldEnableMetalBackgroundWorkers(metal)).toBe(true);
    const all = { K_SERVICE: "matrix-platform-worker", PLATFORM_ROLE: "worker" };
    expect(shouldEnablePlatformBackgroundWorkers(all)).toBe(true);
    expect(shouldEnableMetalBackgroundWorkers(all)).toBe(true);
    // Web replicas run neither on Cloud Run.
    expect(shouldEnableMetalBackgroundWorkers({ K_SERVICE: "matrix-platform-preview" })).toBe(false);
    // The scope only narrows a worker; it never enables workers on a web replica.
    expect(shouldEnableMetalBackgroundWorkers({ K_SERVICE: "matrix-platform-preview", PLATFORM_WORKER_SCOPE: "metal" })).toBe(false);
  });
});
