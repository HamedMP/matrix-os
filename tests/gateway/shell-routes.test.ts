import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";
import { shellError } from "../../packages/gateway/src/shell/errors.js";
import { ShellRegistry } from "../../packages/gateway/src/shell/registry.js";
import { createRateLimiter } from "../../packages/gateway/src/security/rate-limiter.js";

const roots: string[] = [];
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-routes-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gateway shell routes", () => {
  function appWithRegistry(registry: {
    list: () => Promise<unknown[]>;
    get?: (name: string) => Promise<unknown>;
    create: (input: unknown) => Promise<unknown>;
    delete: (name: string, options?: { force?: boolean }) => Promise<void>;
    rename?: (name: string, nextName: string) => Promise<unknown>;
    reorder?: (order: string[]) => Promise<unknown[]>;
  }, shellBackend?: { health: () => Promise<{ ok: boolean; code: string }> }, extraDeps: Record<string, unknown> = {}) {
    const app = new Hono();
    app.route("/api/terminal", createShellRoutes({ registry, shellBackend, ...extraDeps }));
    app.route("/api", createShellRoutes({ registry, shellBackend, ...extraDeps }));
    return app;
  }

  it("lists sessions", async () => {
    const app = appWithRegistry({
      list: vi.fn(async () => [{ name: "main", status: "active" }]),
      create: vi.fn(),
      delete: vi.fn(),
    });

    const res = await app.request("/api/sessions");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sessions: [{ name: "main", status: "active" }],
    });
  });

  it("serves canonical terminal sessions routes under /api/terminal", async () => {
    const registry = {
      list: vi.fn(async () => [{ name: "main", status: "active" }]),
      create: vi.fn(async () => ({ name: "setup" })),
      delete: vi.fn(async () => undefined),
    };
    const app = appWithRegistry(registry);

    await expect((await app.request("/api/terminal/sessions")).json()).resolves.toEqual({
      sessions: [{ name: "main", status: "active" }],
    });
    const created = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "setup" }),
    });
    expect(created.status).toBe(201);
    await app.request("/api/terminal/sessions/setup?force=1", { method: "DELETE" });

    expect(registry.create).toHaveBeenCalledWith({ name: "setup" });
    expect(registry.delete).toHaveBeenCalledWith("setup", { force: true });
  });

  it("serves reconciled aliases and stale pane recovery through the terminal sessions route", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      join(root, "system", "shell-sessions.json"),
      JSON.stringify({
        aliases: {
          "workspace-main": "main",
          "matrix-sess_run_8162a7cca11891c0": "main",
        },
        references: [
          { id: "pane-stale-docs", source: "pane", sessionName: "docs" },
        ],
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });
    const app = appWithRegistry(registry);

    const res = await app.request("/api/terminal/sessions");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sessions: [
        {
          name: "main",
          canonicalName: "main",
          attachCommand: "mos shell attach main",
          aliases: [
            { name: "matrix-sess_run_8162a7cca11891c0", target: "main", source: "legacy" },
            { name: "workspace-main", target: "main", source: "workspace" },
          ],
        },
        {
          name: "docs",
          status: "exited",
          recoverable: true,
          recoveryReason: "missing_runtime_session",
          references: [{ id: "pane-stale-docs", source: "pane", sessionName: "docs" }],
        },
      ],
    });
    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.deleteSession).not.toHaveBeenCalled();

    const deleteRes = await app.request("/api/terminal/sessions/matrix-sess_run_8162a7cca11891c0", {
      method: "DELETE",
    });

    expect(deleteRes.status).toBe(200);
    expect(adapter.deleteSession).toHaveBeenCalledWith("main", { force: false });
  });

  it("creates sessions through a bounded JSON route", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ name: "main" })),
      delete: vi.fn(),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "main", cwd: "~/projects" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ name: "main", created: true });
    expect(registry.create).toHaveBeenCalledWith({ name: "main", cwd: "~/projects" });
  });

  it("rate limits rapid shell session creation without imposing a live-session cap", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(async (input: { name: string }) => ({ name: input.name })),
      delete: vi.fn(),
    };
    const sessionCreateRateLimiter = createRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 0,
      maxKeys: 1,
    });
    const app = new Hono();
    const deps = { registry, sessionCreateRateLimiter };
    app.route("/api/terminal", createShellRoutes(deps));
    app.route("/api", createShellRoutes(deps));

    const first = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "main" }),
    });
    const second = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "next" }),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({
      error: { code: "rate_limited", message: "Request failed" },
    });
    expect(registry.create).toHaveBeenCalledTimes(1);
  });

  it("runs non-interactive commands through a bounded JSON route", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const commandRunner = {
      run: vi.fn(async () => ({
        stdout: "file.txt\n",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 12,
      })),
    };
    const app = new Hono();
    app.route("/api/terminal", createShellRoutes({ registry, commandRunner }));

    const res = await app.request("/api/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: ["ls"], cwd: "projects/app" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      stdout: "file.txt\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      durationMs: 12,
    });
    expect(commandRunner.run).toHaveBeenCalledWith({ command: ["ls"], cwd: "projects/app" });
  });

  it("uploads pasted terminal image assets into the project-local paste directory", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "projects", "app"), { recursive: true });
    const registry = {
      list: vi.fn(async () => [{ name: "main", status: "active" }]),
      get: vi.fn(async () => ({ name: "main", status: "active" })),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const app = appWithRegistry(registry, undefined, { homePath: root });

    const res = await app.request("/api/terminal/sessions/main/paste-assets?cwd=projects/app", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-Matrix-Filename": "Screenshot 2026-07-07 at 6.50.39 PM.png",
      },
      body: PNG_BYTES,
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {
      path: string;
      terminalPath: string;
      size: number;
      mimeType: string;
    };
    expect(body).toMatchObject({
      size: PNG_BYTES.length,
      mimeType: "image/png",
    });
    expect(body.path).toMatch(/^projects\/app\/\.matrix-terminal-pastes\/\d{4}-\d{2}-\d{2}\//);
    expect(body.path.endsWith(".png")).toBe(true);
    expect(body.terminalPath).toBe(join(root, body.path));
    await expect(readFile(body.terminalPath)).resolves.toEqual(Buffer.from(PNG_BYTES));
    expect(registry.get).toHaveBeenCalledWith("main");
  });

  it("rejects unsafe terminal paste uploads with generic client errors", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "projects", "app"), { recursive: true });
    const registry = {
      list: vi.fn(async () => [{ name: "main", status: "active" }]),
      get: vi.fn(async () => ({ name: "main", status: "active" })),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const app = appWithRegistry(registry, undefined, { homePath: root });

    const unsupportedMagic = await app.request("/api/terminal/sessions/main/paste-assets?cwd=projects/app", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: "<svg><script>alert(1)</script></svg>",
    });
    const traversalCwd = await app.request("/api/terminal/sessions/main/paste-assets?cwd=../outside", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG_BYTES,
    });
    const unsafeFilename = await app.request("/api/terminal/sessions/main/paste-assets?cwd=projects/app", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-Matrix-Filename": "../bad.png",
      },
      body: PNG_BYTES,
    });
    const missingSession = await appWithRegistry({
      list: vi.fn(async () => []),
      get: vi.fn(async () => {
        throw shellError("session_not_found", "Session not found", 404);
      }),
      create: vi.fn(),
      delete: vi.fn(),
    }, undefined, { homePath: root }).request("/api/terminal/sessions/missing/paste-assets?cwd=projects/app", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG_BYTES,
    });

    expect(unsupportedMagic.status).toBe(400);
    await expect(unsupportedMagic.json()).resolves.toEqual({
      error: { code: "unsupported_media_type", message: "Invalid request" },
    });
    expect(traversalCwd.status).toBe(400);
    await expect(traversalCwd.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(unsafeFilename.status).toBe(400);
    await expect(unsafeFilename.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(missingSession.status).toBe(404);
    await expect(missingSession.json()).resolves.toEqual({
      error: { code: "session_not_found", message: "Session not found" },
    });
  });

  it("applies the 10 MiB body limit before terminal paste upload handling", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "projects", "app"), { recursive: true });
    const registry = {
      list: vi.fn(async () => [{ name: "main", status: "active" }]),
      get: vi.fn(async () => ({ name: "main", status: "active" })),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const app = appWithRegistry(registry, undefined, { homePath: root });
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set(PNG_BYTES, 0);

    const res = await app.request("/api/terminal/sessions/main/paste-assets?cwd=projects/app", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: oversized,
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: { code: "payload_too_large", message: "Request too large" },
    });
    expect(registry.get).not.toHaveBeenCalled();
  });

  it("sends one-shot terminal input without attaching a subscriber", async () => {
    const registry = {
      list: vi.fn(async () => [{ name: "main", status: "active" }]),
      get: vi.fn(async () => ({ name: "main", status: "active" })),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const terminalInput = {
      sendInput: vi.fn(async () => undefined),
    };
    const app = appWithRegistry(registry, undefined, { terminalInput });

    const res = await app.request("/api/terminal/sessions/main/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "pwd\r" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(registry.get).toHaveBeenCalledWith("main");
    expect(terminalInput.sendInput).toHaveBeenCalledWith("main", "pwd\r");
  });

  it("allows digit-leading session names consistently across create and route params", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ name: "1" })),
      delete: vi.fn(),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "1" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ name: "1", created: true });
    expect(registry.create).toHaveBeenCalledWith({ name: "1" });
  });

  it("deletes sessions with force query support", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/sessions/main?force=1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(registry.delete).toHaveBeenCalledWith("main", { force: true });
  });

  it("deletes legacy matrix session names with force query support under both mounts", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    const app = appWithRegistry(registry);
    const name = "matrix-sess_run_8162a7cca11891c0";

    const terminalRes = await app.request(`/api/terminal/sessions/${name}?force=1`, {
      method: "DELETE",
    });
    const legacyMountRes = await app.request(`/api/sessions/${name}?force=1`, {
      method: "DELETE",
    });

    expect(terminalRes.status).toBe(200);
    expect(legacyMountRes.status).toBe(200);
    expect(registry.delete).toHaveBeenNthCalledWith(1, name, { force: true });
    expect(registry.delete).toHaveBeenNthCalledWith(2, name, { force: true });
  });

  it("persists session order through a bounded JSON route under both mounts", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
      reorder: vi.fn(async (order: string[]) => order.map((name) => ({ name, status: "active" }))),
    };
    const app = appWithRegistry(registry);

    const terminalRes = await app.request("/api/terminal/sessions/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ["bench", "main"] }),
    });
    const apiRes = await app.request("/api/sessions/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ["main", "bench"] }),
    });

    expect(terminalRes.status).toBe(200);
    await expect(terminalRes.json()).resolves.toEqual({
      sessions: [
        { name: "bench", status: "active" },
        { name: "main", status: "active" },
      ],
    });
    expect(apiRes.status).toBe(200);
    expect(registry.reorder).toHaveBeenNthCalledWith(1, ["bench", "main"]);
    expect(registry.reorder).toHaveBeenNthCalledWith(2, ["main", "bench"]);
  });

  it("accepts large valid session order bodies within the schema cap", async () => {
    const order = Array.from({ length: 30 }, (_, index) => `s${String(index).padStart(2, "0")}-${"a".repeat(27)}`);
    expect(JSON.stringify({ order }).length).toBeGreaterThan(1024);
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
      reorder: vi.fn(async (nextOrder: string[]) => nextOrder.map((name) => ({ name, status: "active" }))),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/terminal/sessions/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });

    expect(res.status).toBe(200);
    expect(registry.reorder).toHaveBeenCalledWith(order);
  });

  it("validates session order bodies before dispatch", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
      reorder: vi.fn(),
    };
    const app = appWithRegistry(registry);

    const invalidName = await app.request("/api/terminal/sessions/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ["Main"] }),
    });
    const tooLarge = await app.request("/api/terminal/sessions/order", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "9000",
      },
      body: JSON.stringify({ order: ["main"] }),
    });

    expect(invalidName.status).toBe(400);
    expect(tooLarge.status).toBe(413);
    expect(registry.reorder).not.toHaveBeenCalled();
  });

  it("renames sessions through a bounded JSON route", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(async () => ({
        name: "review-main",
        status: "active",
        placement: "background",
      })),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/terminal/sessions/main/rename", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "review-main" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      session: {
        name: "review-main",
        status: "active",
        placement: "background",
      },
    });
    expect(registry.rename).toHaveBeenCalledWith("main", "review-main");
  });

  it("keeps rename target names aligned with session creation names", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/terminal/sessions/matrix-sess_run_8162a7cca11891c0/rename", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "review_main" }),
    });

    expect(res.status).toBe(400);
    expect(registry.rename).not.toHaveBeenCalled();
  });

  it("validates session rename params and body before dispatch", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
    };
    const app = appWithRegistry(registry);

    const invalidParam = await app.request("/api/terminal/sessions/Main/rename", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "review-main" }),
    });
    const invalidBody = await app.request("/api/terminal/sessions/main/rename", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Review Main" }),
    });
    const tooLarge = await app.request("/api/terminal/sessions/main/rename", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "2048",
      },
      body: JSON.stringify({ name: "x".repeat(2048) }),
    });

    expect(invalidParam.status).toBe(400);
    expect(invalidBody.status).toBe(400);
    expect(tooLarge.status).toBe(413);
    expect(registry.rename).not.toHaveBeenCalled();
  });

  it("caps ignored DELETE request bodies", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/sessions/main", {
      method: "DELETE",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "1024",
      },
      body: "x".repeat(1024),
    });

    expect(res.status).toBe(413);
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("rejects unsafe session route parameters before dispatch", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/sessions/Main", { method: "DELETE" });

    expect(res.status).toBe(400);
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("rejects traversal cwd values in session bodies", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ name: "main" })),
      delete: vi.fn(),
    };
    const app = appWithRegistry(registry);

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "main", cwd: "../outside" }),
    });

    expect(res.status).toBe(400);
    expect(registry.create).not.toHaveBeenCalled();
  });

  it("validates workspace session and layout params at the route boundary", async () => {
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const workspace = {
      listTabs: vi.fn(async () => []),
      createTab: vi.fn(),
      switchTab: vi.fn(),
      closeTab: vi.fn(),
      splitPane: vi.fn(),
      closePane: vi.fn(),
      applyLayout: vi.fn(),
      dumpLayout: vi.fn(),
    };
    const app = new Hono();
    app.route("/api/terminal", createShellRoutes({ registry, workspace }));
    app.route("/api", createShellRoutes({ registry, workspace }));

    const res = await app.request("/api/sessions/main/layouts/BadLayout/apply", { method: "POST" });

    expect(res.status).toBe(400);
    expect(workspace.applyLayout).not.toHaveBeenCalled();
  });

  it("maps internal errors to generic stable responses", async () => {
    const err = Object.assign(new Error("/home/alice leaked"), {
      code: "session_not_found",
      safeMessage: "Session not found",
      status: 404,
    });
    const app = appWithRegistry({
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(async () => {
        throw err;
      }),
    });

    const res = await app.request("/api/sessions/missing", { method: "DELETE" });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: { code: "session_not_found", message: "Session not found" },
    });
  });

  it("checks shell backend health without listing or mutating sessions", async () => {
    const registry = {
      list: vi.fn(async () => [{ name: "main" }]),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const shellBackend = {
      health: vi.fn(async () => ({ ok: true, code: "ok" })),
    };
    const app = appWithRegistry(registry, shellBackend);

    const res = await app.request("/api/terminal/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ shell: { ok: true, code: "ok" } });
    expect(shellBackend.health).toHaveBeenCalledTimes(1);
    expect(registry.list).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("returns coarse shell backend health failures only", async () => {
    const app = appWithRegistry({
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
    }, {
      health: vi.fn(async () => ({ ok: false, code: "zellij_failed" })),
    });

    const res = await app.request("/api/terminal/health");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ shell: { ok: false, code: "zellij_failed" } });
  });

  it("adds coarse terminal session diagnostics to health on request", async () => {
    const registry = {
      list: vi.fn(async () => [
        { name: "main", status: "active", placement: "active", unread: true, visualStatus: "running" },
        { name: "docs", status: "active", placement: "background", unread: false, visualStatus: "waiting" },
        { name: "old", status: "exited", placement: "active", unread: false, visualStatus: "idle" },
      ]),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const app = appWithRegistry(registry, {
      health: vi.fn(async () => ({ ok: true, code: "ok" })),
    });

    const res = await app.request("/api/terminal/health?include=sessions");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      shell: {
        ok: true,
        code: "ok",
        sessions: {
          ok: true,
          total: 3,
          active: 2,
          background: 1,
          unread: 1,
          waiting: 1,
          exited: 1,
        },
      },
    });
    expect(registry.list).toHaveBeenCalledTimes(1);
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("keeps shell health healthy when only session diagnostics fail", async () => {
    const app = appWithRegistry({
      list: vi.fn(async () => {
        throw new Error("/home/matrix/home/system/shell-sessions.json unavailable");
      }),
      create: vi.fn(),
      delete: vi.fn(),
    }, {
      health: vi.fn(async () => ({ ok: true, code: "ok" })),
    });

    const res = await app.request("/api/terminal/health?include=sessions");
    const bodyText = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(bodyText)).toEqual({
      shell: {
        ok: true,
        code: "ok",
        sessions: {
          ok: false,
          code: "session_list_unavailable",
        },
      },
    });
    expect(bodyText).not.toContain("/home/matrix");
    expect(bodyText).not.toContain("shell-sessions.json");
  });
});
