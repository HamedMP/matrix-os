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

  it("rejects legacy session-indexed tab actions", async () => {
    const workspace = {
      listTabs: vi.fn(async () => [{ idx: 0, name: "main", focused: true }]),
      createTab: vi.fn(async () => ({ idx: 1, name: "api" })),
      switchTab: vi.fn(async () => ({ ok: true })),
      closeTab: vi.fn(async () => ({ ok: true })),
    };
    const app = appWithWorkspace(workspace);

    const list = await app.request("/api/sessions/main/tabs");
    const create = await app.request("/api/sessions/main/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api", cwd: "~/repo", cmd: "pnpm dev" }),
    });
    const switchTab = await app.request("/api/sessions/main/tabs/1/go", {
      method: "POST",
    });
    const close = await app.request("/api/sessions/main/tabs/1", {
      method: "DELETE",
    });

    expect([list.status, create.status, switchTab.status, close.status]).toEqual([426, 426, 426, 426]);
    expect(workspace.createTab).not.toHaveBeenCalled();
    expect(workspace.switchTab).not.toHaveBeenCalled();
    expect(workspace.closeTab).not.toHaveBeenCalled();
  });

  it("rejects legacy tab routes before evaluating malformed requests", async () => {
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

    expect(res.status).toBe(426);
    await expect(res.json()).resolves.toEqual({
      error: "client_upgrade_required",
      message: "Upgrade Matrix OS to use terminal workspaces.",
    });
  });
});
