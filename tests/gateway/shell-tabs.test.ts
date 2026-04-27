import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";

describe("gateway shell tab routes", () => {
  function appWithWorkspace(workspace: Record<string, unknown>) {
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
      workspace: workspace as never,
    }));
    return app;
  }

  it("lists, creates, switches, and closes tabs with validated inputs", async () => {
    const workspace = {
      listTabs: vi.fn(async () => [{ idx: 0, name: "main", focused: true }]),
      createTab: vi.fn(async () => ({ idx: 1, name: "api" })),
      switchTab: vi.fn(async () => ({ ok: true })),
      closeTab: vi.fn(async () => ({ ok: true })),
    };
    const app = appWithWorkspace(workspace);

    await expect((await app.request("/api/sessions/main/tabs")).json()).resolves.toEqual({
      tabs: [{ idx: 0, name: "main", focused: true }],
    });
    await expect((await app.request("/api/sessions/main/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api", cwd: "~/repo", cmd: "pnpm dev" }),
    })).json()).resolves.toEqual({ tab: { idx: 1, name: "api" } });
    await expect((await app.request("/api/sessions/main/tabs/1/go", {
      method: "POST",
    })).json()).resolves.toEqual({ ok: true });
    await expect((await app.request("/api/sessions/main/tabs/1", {
      method: "DELETE",
    })).json()).resolves.toEqual({ ok: true });

    expect(workspace.createTab).toHaveBeenCalledWith("main", {
      name: "api",
      cwd: "~/repo",
      cmd: "pnpm dev",
    });
    expect(workspace.switchTab).toHaveBeenCalledWith("main", 1);
    expect(workspace.closeTab).toHaveBeenCalledWith("main", 1);
  });

  it("rejects malformed tab requests with generic errors", async () => {
    const app = appWithWorkspace({
      listTabs: vi.fn(),
      createTab: vi.fn(),
      switchTab: vi.fn(),
      closeTab: vi.fn(),
    });

    const res = await app.request("/api/sessions/main/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../bad" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });
});
