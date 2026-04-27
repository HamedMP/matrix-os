import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";

describe("gateway shell pane routes", () => {
  function appWithWorkspace(workspace: Record<string, unknown>) {
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
      workspace: workspace as never,
    }));
    return app;
  }

  it("splits and closes panes with body limits and validation", async () => {
    const workspace = {
      splitPane: vi.fn(async () => ({ paneId: "pane-2" })),
      closePane: vi.fn(async () => ({ ok: true })),
    };
    const app = appWithWorkspace(workspace);

    await expect((await app.request("/api/sessions/main/panes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "right", cwd: "~/repo", cmd: "vim" }),
    })).json()).resolves.toEqual({ pane: { paneId: "pane-2" } });
    await expect((await app.request("/api/sessions/main/panes/pane-2", {
      method: "DELETE",
    })).json()).resolves.toEqual({ ok: true });

    expect(workspace.splitPane).toHaveBeenCalledWith("main", {
      direction: "right",
      cwd: "~/repo",
      cmd: "vim",
    });
    expect(workspace.closePane).toHaveBeenCalledWith("main", "pane-2");
  });

  it("rejects unsafe cwd values before invoking zellij", async () => {
    const workspace = {
      splitPane: vi.fn(),
      closePane: vi.fn(),
    };
    const app = appWithWorkspace(workspace);

    const res = await app.request("/api/sessions/main/panes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "down", cwd: "/etc" }),
    });

    expect(res.status).toBe(400);
    expect(workspace.splitPane).not.toHaveBeenCalled();
  });
});
