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

  it("rejects legacy native-pane creation and deletion", async () => {
    const workspace = {
      splitPane: vi.fn(async () => ({ paneId: "pane-2" })),
      closePane: vi.fn(async () => ({ ok: true })),
    };
    const app = appWithWorkspace(workspace);

    const split = await app.request("/api/sessions/main/panes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "right", cwd: "~/repo", cmd: "vim" }),
    });
    const close = await app.request("/api/sessions/main/panes/pane-2", {
      method: "DELETE",
    });

    expect(split.status).toBe(426);
    expect(close.status).toBe(426);
    expect(workspace.splitPane).not.toHaveBeenCalled();
    expect(workspace.closePane).not.toHaveBeenCalled();
  });

  it("rejects legacy pane routes before evaluating their payload", async () => {
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

    expect(res.status).toBe(426);
    expect(workspace.splitPane).not.toHaveBeenCalled();
  });
});
