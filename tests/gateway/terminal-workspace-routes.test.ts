import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTerminalWorkspaceRoutes } from "../../packages/gateway/src/shell/workspace-routes.js";

const workspace = {
  id: "tws_0123456789abcdef0123456789abcdef",
  scope: "project" as const,
  projectId: "matrix-os",
  canonicalSize: { cols: 120, rows: 36 },
  status: "running" as const,
  revision: 1,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  tabs: [],
};

describe("terminal workspace gateway routes", () => {
  it("validates workspace/tab mutations and requires deletion confirmation", async () => {
    const runtime = {
      listWorkspaces: vi.fn(async () => [workspace]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(async () => ({
        id: "tt_0123456789abcdef0123456789abcdef",
        workspaceId: workspace.id,
        name: "main",
        cwd: "projects/matrix-os",
        status: "running" as const,
        revision: 1,
        order: 0,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })),
      deletionImpact: vi.fn(async () => ({ runningTabs: 1, tabs: [] })),
      deleteWorkspace: vi.fn(async () => undefined),
    };
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({ runtime }));

    expect((await app.request("/api/terminal/workspaces")).status).toBe(200);
    expect((await app.request("/api/terminal/workspaces/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "matrix-os" }),
    })).status).toBe(200);
    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "main", cwd: "projects/matrix-os" }),
    })).status).toBe(201);

    expect((await app.request(`/api/terminal/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmTerminate: false }),
    })).status).toBe(409);
    expect(runtime.deleteWorkspace).not.toHaveBeenCalled();
    expect((await app.request(`/api/terminal/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmTerminate: true }),
    })).status).toBe(204);
  });

  it("binds a Chat terminal by stable workspace/tab ref and cleans up failed bindings", async () => {
    const tab = {
      id: "tt_0123456789abcdef0123456789abcdef",
      workspaceId: workspace.id,
      name: "Chat terminal",
      cwd: "projects/matrix-os",
      status: "running" as const,
      revision: 1,
      order: 0,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
    const runtime = {
      listWorkspaces: vi.fn(async () => [workspace]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(async () => tab),
      terminateTab: vi.fn(async () => undefined),
      deletionImpact: vi.fn(async () => ({ runningTabs: 0, tabs: [] })),
      deleteWorkspace: vi.fn(async () => undefined),
    };
    const prepare = vi.fn(async () => ({ runId: "run_selected", cwd: "projects/matrix-os" }));
    const bind = vi.fn(async () => undefined);
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({
      runtime,
      getPrincipal: () => ({ userId: "user_selected", source: "jwt" }),
      chatTerminals: { prepare, bind },
    }));

    const response = await app.request(`/api/terminal/workspaces/${workspace.id}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Chat terminal", cwd: "", chatId: "chat_selected" }),
    });

    expect(response.status).toBe(201);
    expect(runtime.createTab).toHaveBeenCalledWith(workspace.id, {
      name: "Chat terminal",
      cwd: "projects/matrix-os",
    });
    expect(bind).toHaveBeenCalledWith(
      { userId: "user_selected", source: "jwt" },
      {
        chatId: "chat_selected",
        runId: "run_selected",
        sessionId: `${workspace.id}:${tab.id}`,
        sessionCreatedAt: tab.createdAt,
      },
    );
    expect(runtime.terminateTab).not.toHaveBeenCalled();

    bind.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Chat terminal", cwd: "", chatId: "chat_selected" }),
    })).status).toBe(500);
    expect(runtime.terminateTab).toHaveBeenCalledWith({ workspaceId: workspace.id, tabId: tab.id });
  });
});
