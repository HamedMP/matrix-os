import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import {
  loadHealthCheckTargets,
  checkModuleHealth,
  backupModule,
  restoreModule,
  createHeartbeat,
  type HealthTarget,
  type HealthCheckResult,
  type Heartbeat,
} from "../../packages/kernel/src/heartbeat.js";

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-test-"));
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "modules"), { recursive: true });
  return dir;
}

function startServer(
  handler: (
    req: { url?: string },
    res: { writeHead: (code: number) => void; end: (body?: string) => void },
  ) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe("loadHealthCheckTargets", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("returns targets for modules with port in modules.json", () => {
    writeFileSync(
      join(homePath, "system/modules.json"),
      JSON.stringify([
        { name: "api-server", type: "module", path: "~/modules/api-server", port: 3100, status: "running" },
      ]),
    );
    mkdirSync(join(homePath, "modules/api-server"), { recursive: true });
    writeFileSync(
      join(homePath, "modules/api-server/manifest.json"),
      JSON.stringify({ name: "api-server", health: "/health", port: 3100 }),
    );

    const targets = loadHealthCheckTargets(homePath);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({
      name: "api-server",
      port: 3100,
      healthPath: "/health",
    });
  });

  it("skips static modules without port", () => {
    writeFileSync(
      join(homePath, "system/modules.json"),
      JSON.stringify([
        { name: "hello-world", type: "app", path: "~/modules/hello-world", status: "active" },
        { name: "api-server", type: "module", path: "~/modules/api-server", port: 3100, status: "running" },
      ]),
    );
    mkdirSync(join(homePath, "modules/api-server"), { recursive: true });
    writeFileSync(
      join(homePath, "modules/api-server/manifest.json"),
      JSON.stringify({ name: "api-server", port: 3100 }),
    );

    const targets = loadHealthCheckTargets(homePath);
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe("api-server");
  });

  it("defaults healthPath to /health when manifest has no health field", () => {
    writeFileSync(
      join(homePath, "system/modules.json"),
      JSON.stringify([
        { name: "api-server", type: "module", path: "~/modules/api-server", port: 3100, status: "running" },
      ]),
    );
    mkdirSync(join(homePath, "modules/api-server"), { recursive: true });
    writeFileSync(
      join(homePath, "modules/api-server/manifest.json"),
      JSON.stringify({ name: "api-server", port: 3100 }),
    );

    const targets = loadHealthCheckTargets(homePath);
    expect(targets[0].healthPath).toBe("/health");
  });

  it("reads custom health path from manifest", () => {
    writeFileSync(
      join(homePath, "system/modules.json"),
      JSON.stringify([
        { name: "api-server", type: "module", path: "~/modules/api-server", port: 3100, status: "running" },
      ]),
    );
    mkdirSync(join(homePath, "modules/api-server"), { recursive: true });
    writeFileSync(
      join(homePath, "modules/api-server/manifest.json"),
      JSON.stringify({ name: "api-server", port: 3100, health: "/api/status" }),
    );

    const targets = loadHealthCheckTargets(homePath);
    expect(targets[0].healthPath).toBe("/api/status");
  });

  it("returns empty array when modules.json is missing", () => {
    const targets = loadHealthCheckTargets(homePath);
    expect(targets).toEqual([]);
  });

  it("returns empty array when modules.json is empty", () => {
    writeFileSync(join(homePath, "system/modules.json"), "[]");
    const targets = loadHealthCheckTargets(homePath);
    expect(targets).toEqual([]);
  });

  it("skips module when manifest.json is missing", () => {
    writeFileSync(
      join(homePath, "system/modules.json"),
      JSON.stringify([
        { name: "ghost-module", type: "module", path: "~/modules/ghost-module", port: 3100, status: "running" },
      ]),
    );

    const targets = loadHealthCheckTargets(homePath);
    expect(targets).toHaveLength(1);
    expect(targets[0].healthPath).toBe("/health");
  });
});

describe("checkModuleHealth", () => {
  let server: Server;
  let port: number;

  afterEach(() => {
    if (server) server.close();
  });

  it("returns ok:true for 200 response", async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('{"status":"ok"}');
    }));

    const result = await checkModuleHealth(port, "/health", 3000);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns ok:false for non-200 response", async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    }));

    const result = await checkModuleHealth(port, "/health", 3000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });

  it("returns ok:false on timeout", async () => {
    ({ server, port } = await startServer((_req, _res) => {
      // never respond
    }));

    const result = await checkModuleHealth(port, "/health", 100);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
  });

  it("returns ok:false on connection refused", async () => {
    const result = await checkModuleHealth(59999, "/health", 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("backupModule", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("copies module directory to .backup/{name}/", () => {
    const modulePath = join(homePath, "modules/my-mod");
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(join(modulePath, "index.js"), "console.log('hello');");
    writeFileSync(join(modulePath, "manifest.json"), '{"name":"my-mod"}');

    const backupPath = backupModule(homePath, "my-mod", modulePath);
    expect(backupPath).toBe(join(homePath, ".backup", "my-mod"));
    expect(existsSync(join(backupPath, "index.js"))).toBe(true);
    expect(existsSync(join(backupPath, "manifest.json"))).toBe(true);
    expect(readFileSync(join(backupPath, "index.js"), "utf-8")).toBe("console.log('hello');");
  });

  it("overwrites existing backup", () => {
    const modulePath = join(homePath, "modules/my-mod");
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(join(modulePath, "index.js"), "version 1");

    backupModule(homePath, "my-mod", modulePath);

    writeFileSync(join(modulePath, "index.js"), "version 2");
    backupModule(homePath, "my-mod", modulePath);

    const backupPath = join(homePath, ".backup", "my-mod");
    expect(readFileSync(join(backupPath, "index.js"), "utf-8")).toBe("version 2");
  });

  it("creates .backup directory if it does not exist", () => {
    const modulePath = join(homePath, "modules/my-mod");
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(join(modulePath, "index.js"), "hello");

    expect(existsSync(join(homePath, ".backup"))).toBe(false);
    backupModule(homePath, "my-mod", modulePath);
    expect(existsSync(join(homePath, ".backup"))).toBe(true);
  });

  it("returns the backup path", () => {
    const modulePath = join(homePath, "modules/my-mod");
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(join(modulePath, "index.js"), "hello");

    const result = backupModule(homePath, "my-mod", modulePath);
    expect(result).toBe(join(homePath, ".backup", "my-mod"));
  });
});

describe("restoreModule", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("restores from .backup/ to module directory", () => {
    const modulePath = join(homePath, "modules/my-mod");
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(join(modulePath, "index.js"), "original");

    backupModule(homePath, "my-mod", modulePath);

    writeFileSync(join(modulePath, "index.js"), "corrupted");

    const result = restoreModule(homePath, "my-mod", modulePath);
    expect(result).toBe(true);
    expect(readFileSync(join(modulePath, "index.js"), "utf-8")).toBe("original");
  });

  it("returns false if no backup exists", () => {
    const modulePath = join(homePath, "modules/my-mod");
    mkdirSync(modulePath, { recursive: true });

    const result = restoreModule(homePath, "my-mod", modulePath);
    expect(result).toBe(false);
  });

  it("replaces module directory contents entirely", () => {
    const modulePath = join(homePath, "modules/my-mod");
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(join(modulePath, "index.js"), "original");

    backupModule(homePath, "my-mod", modulePath);

    writeFileSync(join(modulePath, "extra.js"), "extra file");
    const result = restoreModule(homePath, "my-mod", modulePath);
    expect(result).toBe(true);
    expect(existsSync(join(modulePath, "extra.js"))).toBe(false);
    expect(existsSync(join(modulePath, "index.js"))).toBe(true);
  });
});

describe("createHeartbeat", () => {
  let homePath: string;
  let servers: Server[] = [];

  beforeEach(() => {
    homePath = tmpHome();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const s of servers) s.close();
    servers = [];
    rmSync(homePath, { recursive: true, force: true });
  });

  function setupModule(name: string, port: number, health = "/health") {
    writeFileSync(
      join(homePath, "system/modules.json"),
      JSON.stringify([{ name, type: "module", path: `~/modules/${name}`, port, status: "running" }]),
    );
    mkdirSync(join(homePath, `modules/${name}`), { recursive: true });
    writeFileSync(
      join(homePath, `modules/${name}/manifest.json`),
      JSON.stringify({ name, port, health }),
    );
  }

  it("tracks consecutive failures and resets on success", async () => {
    let healthy = true;
    const { server, port } = await startServer((_req, res) => {
      if (healthy) {
        res.writeHead(200);
        res.end('{"status":"ok"}');
      } else {
        res.writeHead(500);
        res.end("error");
      }
    });
    servers.push(server);
    vi.useRealTimers();

    setupModule("test-mod", port);

    const onHealthFailure = vi.fn();
    const hb = createHeartbeat({
      homePath,
      intervalMs: 1000,
      failureThreshold: 3,
      timeoutMs: 2000,
      onHealthFailure,
    });

    await hb.check();
    expect(hb.getStatus().get("test-mod")?.consecutiveFailures).toBe(0);

    healthy = false;
    await hb.check();
    expect(hb.getStatus().get("test-mod")?.consecutiveFailures).toBe(1);

    await hb.check();
    expect(hb.getStatus().get("test-mod")?.consecutiveFailures).toBe(2);

    healthy = true;
    await hb.check();
    expect(hb.getStatus().get("test-mod")?.consecutiveFailures).toBe(0);

    hb.stop();
  });

  it("fires onHealthFailure at threshold", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });
    servers.push(server);
    vi.useRealTimers();

    setupModule("failing-mod", port);

    const onHealthFailure = vi.fn();
    const hb = createHeartbeat({
      homePath,
      intervalMs: 1000,
      failureThreshold: 3,
      timeoutMs: 2000,
      onHealthFailure,
    });

    await hb.check();
    await hb.check();
    expect(onHealthFailure).not.toHaveBeenCalled();

    await hb.check();
    expect(onHealthFailure).toHaveBeenCalledTimes(1);
    expect(onHealthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ name: "failing-mod", port }),
      expect.any(String),
    );

    hb.stop();
  });

  it("fires only once per episode (cooldown)", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });
    servers.push(server);
    vi.useRealTimers();

    setupModule("failing-mod", port);

    const onHealthFailure = vi.fn();
    const hb = createHeartbeat({
      homePath,
      intervalMs: 1000,
      failureThreshold: 2,
      timeoutMs: 2000,
      onHealthFailure,
    });

    await hb.check();
    await hb.check(); // triggers
    await hb.check(); // should NOT trigger again
    await hb.check(); // should NOT trigger again

    expect(onHealthFailure).toHaveBeenCalledTimes(1);

    hb.stop();
  });

  it("resets cooldown after recovery and re-triggers on new episode", async () => {
    let healthy = false;
    const { server, port } = await startServer((_req, res) => {
      if (healthy) {
        res.writeHead(200);
        res.end('{"status":"ok"}');
      } else {
        res.writeHead(500);
        res.end("error");
      }
    });
    servers.push(server);
    vi.useRealTimers();

    setupModule("flaky-mod", port);

    const onHealthFailure = vi.fn();
    const hb = createHeartbeat({
      homePath,
      intervalMs: 1000,
      failureThreshold: 2,
      timeoutMs: 2000,
      onHealthFailure,
    });

    await hb.check();
    await hb.check(); // trigger 1
    expect(onHealthFailure).toHaveBeenCalledTimes(1);

    healthy = true;
    await hb.check(); // recovery

    healthy = false;
    await hb.check();
    await hb.check(); // trigger 2
    expect(onHealthFailure).toHaveBeenCalledTimes(2);

    hb.stop();
  });

  it("stop() clears interval", async () => {
    vi.useRealTimers();

    writeFileSync(join(homePath, "system/modules.json"), "[]");

    const hb = createHeartbeat({
      homePath,
      intervalMs: 100,
      failureThreshold: 3,
      timeoutMs: 1000,
      onHealthFailure: vi.fn(),
    });

    hb.start();
    hb.stop();

    // After stop, no more checks should run. If interval leaked, this would eventually throw.
    await new Promise((r) => setTimeout(r, 250));
  });

  it("getStatus() returns health map", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('{"status":"ok"}');
    });
    servers.push(server);
    vi.useRealTimers();

    setupModule("healthy-mod", port);

    const hb = createHeartbeat({
      homePath,
      intervalMs: 1000,
      failureThreshold: 3,
      timeoutMs: 2000,
      onHealthFailure: vi.fn(),
    });

    await hb.check();

    const status = hb.getStatus();
    expect(status).toBeInstanceOf(Map);
    expect(status.has("healthy-mod")).toBe(true);
    expect(status.get("healthy-mod")).toEqual({
      consecutiveFailures: 0,
      healingTriggered: false,
      lastError: undefined,
    });

    hb.stop();
  });

  it("handles multiple modules independently", async () => {
    const { server: s1, port: p1 } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('{"status":"ok"}');
    });
    const { server: s2, port: p2 } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });
    servers.push(s1, s2);
    vi.useRealTimers();

    writeFileSync(
      join(homePath, "system/modules.json"),
      JSON.stringify([
        { name: "good-mod", type: "module", path: "~/modules/good-mod", port: p1, status: "running" },
        { name: "bad-mod", type: "module", path: "~/modules/bad-mod", port: p2, status: "running" },
      ]),
    );
    mkdirSync(join(homePath, "modules/good-mod"), { recursive: true });
    writeFileSync(join(homePath, "modules/good-mod/manifest.json"), JSON.stringify({ name: "good-mod", port: p1 }));
    mkdirSync(join(homePath, "modules/bad-mod"), { recursive: true });
    writeFileSync(join(homePath, "modules/bad-mod/manifest.json"), JSON.stringify({ name: "bad-mod", port: p2 }));

    const onHealthFailure = vi.fn();
    const hb = createHeartbeat({
      homePath,
      intervalMs: 1000,
      failureThreshold: 2,
      timeoutMs: 2000,
      onHealthFailure,
    });

    await hb.check();
    await hb.check();

    const status = hb.getStatus();
    expect(status.get("good-mod")?.consecutiveFailures).toBe(0);
    expect(status.get("bad-mod")?.consecutiveFailures).toBe(2);
    expect(onHealthFailure).toHaveBeenCalledTimes(1);
    expect(onHealthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bad-mod" }),
      expect.any(String),
    );

    hb.stop();
  });

  it("reloads targets on each check (detects new modules)", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('{"status":"ok"}');
    });
    servers.push(server);
    vi.useRealTimers();

    writeFileSync(join(homePath, "system/modules.json"), "[]");

    const hb = createHeartbeat({
      homePath,
      intervalMs: 1000,
      failureThreshold: 3,
      timeoutMs: 2000,
      onHealthFailure: vi.fn(),
    });

    await hb.check();
    expect(hb.getStatus().size).toBe(0);

    // Add a module dynamically
    setupModule("new-mod", port);
    await hb.check();
    expect(hb.getStatus().has("new-mod")).toBe(true);

    hb.stop();
  });
});
