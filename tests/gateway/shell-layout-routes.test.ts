import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";

describe("gateway shell layout routes", () => {
  function appWithDeps(deps: { layouts: Record<string, unknown>; workspace: Record<string, unknown> }) {
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
      layouts: deps.layouts as never,
      workspace: deps.workspace as never,
    }));
    return app;
  }

  it("lists, shows, saves, applies, dumps, and deletes layouts", async () => {
    const layouts = {
      list: vi.fn(async () => [{ name: "dev", modifiedAt: "2026-01-01T00:00:00.000Z" }]),
      show: vi.fn(async () => ({ name: "dev", kdl: "layout {}" })),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const workspace = {
      applyLayout: vi.fn(async () => ({ ok: true })),
      dumpLayout: vi.fn(async () => ({ kdl: "layout {}" })),
    };
    const app = appWithDeps({ layouts, workspace });

    await expect((await app.request("/api/layouts")).json()).resolves.toEqual({
      layouts: [{ name: "dev", modifiedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await expect((await app.request("/api/layouts/dev")).json()).resolves.toEqual({
      layout: { name: "dev", kdl: "layout {}" },
    });
    await expect((await app.request("/api/layouts/dev", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kdl: "layout {}" }),
    })).json()).resolves.toEqual({ ok: true });
    await expect((await app.request("/api/sessions/main/layouts/dev/apply", {
      method: "POST",
    })).json()).resolves.toEqual({ ok: true });
    await expect((await app.request("/api/sessions/main/layout/dump")).json()).resolves.toEqual({
      layout: { kdl: "layout {}" },
    });
    await expect((await app.request("/api/layouts/dev", { method: "DELETE" })).json()).resolves.toEqual({ ok: true });

    expect(layouts.save).toHaveBeenCalledWith("dev", "layout {}");
    expect(workspace.applyLayout).toHaveBeenCalledWith("main", "dev");
    expect(workspace.dumpLayout).toHaveBeenCalledWith("main");
  });

  it("returns a stable unavailable error when layout storage is not wired", async () => {
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    }));

    const res = await app.request("/api/layouts");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: { code: "layouts_unavailable", message: "Request failed" },
    });
  });
});
