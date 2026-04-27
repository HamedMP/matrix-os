import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";

describe("gateway shell routes", () => {
  function appWithRegistry(registry: {
    list: () => Promise<unknown[]>;
    create: (input: unknown) => Promise<unknown>;
    delete: (name: string, options?: { force?: boolean }) => Promise<void>;
  }) {
    const app = new Hono();
    app.route("/api", createShellRoutes({ registry }));
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
});
