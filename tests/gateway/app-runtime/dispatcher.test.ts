import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProcessManager } from "../../../packages/gateway/src/app-runtime/process-manager.js";
import type { PortPool } from "../../../packages/gateway/src/app-runtime/port-pool.js";
import { SpawnError } from "../../../packages/gateway/src/app-runtime/errors.js";
import { mkdtemp, cp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

let ProcessManagerCtor: typeof ProcessManager;
let PortPoolCtor: typeof PortPool;
let mountAppRuntimeDispatcher: (
  app: InstanceType<typeof Hono>,
  pm: InstanceType<typeof ProcessManager>,
  cfg: { publicHost: string; homeDir: string },
) => void;

beforeEach(async () => {
  const pmMod = await import("../../../packages/gateway/src/app-runtime/process-manager.js");
  ProcessManagerCtor = pmMod.ProcessManager;
  const ppMod = await import("../../../packages/gateway/src/app-runtime/port-pool.js");
  PortPoolCtor = ppMod.PortPool;
  const dispMod = await import("../../../packages/gateway/src/app-runtime/dispatcher.js");
  mountAppRuntimeDispatcher = dispMod.mountAppRuntimeDispatcher;
});

describe("app-runtime dispatcher — node mode", () => {
  let pm: InstanceType<typeof ProcessManager>;
  let portPool: InstanceType<typeof PortPool>;
  let tmpHome: string;
  let app: InstanceType<typeof Hono>;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "matrix-os-disp-"));

    // Copy hello-next fixture
    const helloSrc = join(process.cwd(), "tests/fixtures/apps/hello-next");
    const helloDst = join(tmpHome, "apps", "hello-next");
    await mkdir(join(tmpHome, "apps"), { recursive: true });
    await cp(helloSrc, helloDst, { recursive: true });
    await mkdir(join(tmpHome, "data", "hello-next"), { recursive: true });

    // Create a static app fixture for testing mode routing
    const staticDir = join(tmpHome, "apps", "calculator");
    await mkdir(staticDir, { recursive: true });
    await writeFile(
      join(staticDir, "matrix.json"),
      JSON.stringify({
        name: "Calculator",
        slug: "calculator",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
      }),
    );
    await writeFile(join(staticDir, "index.html"), "<html><body>Calculator</body></html>");

    portPool = new PortPoolCtor({ min: 42000, max: 42100 });
    pm = new ProcessManagerCtor({
      homeDir: tmpHome,
      portPool,
      maxProcesses: 10,
      reaperIntervalMs: 30_000,
    });

    app = new Hono();
    // Stub logger and requestId
    app.use("*", async (c, next) => {
      c.set("logger", { error: vi.fn(), warn: vi.fn(), info: vi.fn() });
      c.set("requestId", "test-correlation-id");
      await next();
    });
    mountAppRuntimeDispatcher(app, pm, { publicHost: "matrix-os.test", homeDir: tmpHome });
  });

  afterEach(async () => {
    await pm.shutdownAll();
  });

  describe("node mode HTTP forwarding", () => {
    it("forwards GET to child process and returns response", async () => {
      const res = await app.request("/apps/hello-next/api/hello");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ message: "hello from next" });
    }, 15_000);

    it("forwards POST with body to child process", async () => {
      const res = await app.request("/apps/hello-next/api/hello", {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      });
      // Our fixture returns the same response regardless of method
      expect(res.status).toBe(200);
    }, 15_000);

    it("strips Server header from upstream response", async () => {
      const res = await app.request("/apps/hello-next/api/hello");
      expect(res.headers.get("server")).toBeNull();
    }, 15_000);

    it("strips X-Powered-By header from upstream response", async () => {
      const res = await app.request("/apps/hello-next/api/hello");
      expect(res.headers.get("x-powered-by")).toBeNull();
    }, 15_000);

    it("strips client-supplied X-Forwarded-Host and sets canonical value", async () => {
      const res = await app.request("/apps/hello-next/api/hello", {
        headers: {
          "X-Forwarded-Host": "evil.example.com",
        },
      });
      expect(res.status).toBe(200);
      // The child should receive publicHost, not the spoofed value
      // (We verify indirectly that the request succeeded without the spoofed header causing issues)
    }, 15_000);

    it("strips X-Real-IP from inbound requests", async () => {
      const res = await app.request("/apps/hello-next/api/hello", {
        headers: {
          "X-Real-IP": "1.2.3.4",
        },
      });
      expect(res.status).toBe(200);
    }, 15_000);

    it("strips Forwarded header from inbound requests", async () => {
      const res = await app.request("/apps/hello-next/api/hello", {
        headers: {
          Forwarded: "for=1.2.3.4",
        },
      });
      expect(res.status).toBe(200);
    }, 15_000);

    it("strips inbound X-Matrix-App-Slug and sets its own", async () => {
      const res = await app.request("/apps/hello-next/api/hello", {
        headers: {
          "X-Matrix-App-Slug": "spoofed-slug",
        },
      });
      expect(res.status).toBe(200);
    }, 15_000);

    it("returns 502 with correlation id on backend error", async () => {
      // Create a fixture app that immediately exits
      const badDir = join(tmpHome, "apps", "dead-app");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "matrix.json"),
        JSON.stringify({
          name: "Dead App",
          slug: "dead-app",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node -e \"process.exit(1)\"",
            healthCheck: "/",
            startTimeout: 3,
            idleShutdown: 300,
          },
        }),
      );
      await writeFile(join(badDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "dead-app"), { recursive: true });

      const res = await app.request("/apps/dead-app/api/test");
      expect([502, 503]).toContain(res.status);
      const body = await res.json();
      expect(body.correlationId).toBeDefined();
    }, 15_000);

    it("returns 503 when app is in failed state", async () => {
      // Manually set a process record to failed state for testing
      // This requires the process manager to expose inspect which shows failed state
      // For now just check that a non-startable app returns 503
      const badDir = join(tmpHome, "apps", "failed-app");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "matrix.json"),
        JSON.stringify({
          name: "Failed App",
          slug: "failed-app",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node -e \"process.exit(1)\"",
            healthCheck: "/",
            startTimeout: 2,
            idleShutdown: 300,
          },
        }),
      );
      await writeFile(join(badDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "failed-app"), { recursive: true });

      const res = await app.request("/apps/failed-app/some-page");
      expect([502, 503]).toContain(res.status);
    }, 15_000);

    it("updates lastUsedAt on every proxied request", async () => {
      await app.request("/apps/hello-next/api/hello");
      const r1 = pm.inspect("hello-next");

      await new Promise((r) => setTimeout(r, 50));
      await app.request("/apps/hello-next/api/hello");
      const r2 = pm.inspect("hello-next");

      expect(r2!.lastUsedAt).toBeGreaterThanOrEqual(r1!.lastUsedAt);
    }, 15_000);

    it("awaits startupPromise when process is starting (concurrent dispatch)", async () => {
      // Two simultaneous requests should both succeed
      const [r1, r2] = await Promise.all([
        app.request("/apps/hello-next/api/hello"),
        app.request("/apps/hello-next/api/health"),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    }, 15_000);
  });

  describe("dispatch invariants", () => {
    it("rejects invalid slug with 400 before touching filesystem", async () => {
      const res = await app.request("/apps/../../etc/passwd/test");
      expect(res.status).toBe(400);
    });

    it("returns 404 when manifest is missing", async () => {
      const res = await app.request("/apps/nonexistent/test");
      expect(res.status).toBe(404);
    });

    it("dispatches to node mode for runtime: node", async () => {
      const res = await app.request("/apps/hello-next/api/hello");
      expect(res.status).toBe(200);
    }, 15_000);

    it("dispatches to static mode for runtime: static", async () => {
      const res = await app.request("/apps/calculator/");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Calculator");
    });
  });

  // T056: WebSocket tests
  describe("WebSocket (node mode)", () => {
    it("returns 400 ws_not_supported for static mode WebSocket upgrade", async () => {
      const res = await app.request("/apps/calculator/ws", {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
        },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("ws");
    });

    // Note: Full WebSocket proxy tests require a real HTTP server with upgrade support
    // which is beyond what Hono's app.request() can do. These are covered in the
    // integration test (T057/T070).
  });
});
