import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

function createRoutes(sessionOrchestrator: any) {
  const app = new Hono();
  app.route(
    "/",
    createWorkspaceRoutes({
      homePath: "/tmp/matrix-home",
      projectManager: { getGithubStatus: vi.fn(), listManagedProjects: vi.fn(), createProject: vi.fn(), getProject: vi.fn(), deleteProject: vi.fn(), listPullRequests: vi.fn(), listBranches: vi.fn() } as any,
      worktreeManager: { createWorktree: vi.fn(), listWorktrees: vi.fn(), deleteWorktree: vi.fn() } as any,
      sessionOrchestrator,
      getOwnerScope: () => ({ type: "user", id: "user_123" }),
    }),
  );
  return app;
}

describe("workspace cloud-only policy", () => {
  it("rejects local runtime probes before starting a session", async () => {
    const sessionOrchestrator = { startSession: vi.fn() };
    const res = await createRoutes(sessionOrchestrator).request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "agent",
        agent: "codex",
        projectSlug: "repo",
        worktreeId: "wt_123",
        prompt: "Implement MAT-1",
        runtimeMode: "local",
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "cloud_runtime_required", message: "Cloud agent runtime required" },
    });
    expect(sessionOrchestrator.startSession).not.toHaveBeenCalled();
  });

  it("accepts explicit cloud runtime requests and forwards cloud-only metadata", async () => {
    const sessionOrchestrator = {
      startSession: vi.fn(async () => ({
        ok: true,
        status: 201,
        session: { id: "sess_123", runtime: { type: "zellij", status: "running" } },
      })),
    };
    const res = await createRoutes(sessionOrchestrator).request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "agent",
        agent: "codex",
        projectSlug: "repo",
        worktreeId: "wt_123",
        prompt: "Implement MAT-1",
        runtimeMode: "cloud",
        runtimePreference: "zellij",
      }),
    });

    expect(res.status).toBe(201);
    expect(sessionOrchestrator.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ runtimeMode: "cloud", runtimePreference: "zellij" }),
      }),
    );
  });
});
