import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspace API routes", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-workspace-routes-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns structured generic validation errors for project creation", async () => {
    const app = createWorkspaceRoutes({ homePath });

    const res = await app.request(jsonRequest("/api/projects", { url: "https://example.com/not/github" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "invalid_repository_url",
        message: "Repository URL must point to GitHub",
      },
    });
  });

  it("applies body limits to mutating workspace routes", async () => {
    const app = createWorkspaceRoutes({ homePath });
    const res = await app.request(jsonRequest("/api/projects", { url: "github.com/owner/repo", padding: "x".repeat(70 * 1024) }));

    expect(res.status).toBe(413);
  });

  it("routes GitHub status and worktree creation through injected managers", async () => {
    const projectManager = {
      getGithubStatus: vi.fn(async () => ({ installed: true, authenticated: true, user: "octocat", errorCode: null })),
      createProject: vi.fn(),
      listManagedProjects: vi.fn(),
      getProject: vi.fn(),
      deleteProject: vi.fn(),
      listPullRequests: vi.fn(),
      listBranches: vi.fn(),
    };
    const worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true, status: 201, worktree: { id: "wt_abc", projectSlug: "repo" } })),
      listWorktrees: vi.fn(),
      deleteWorktree: vi.fn(),
    };
    const app = createWorkspaceRoutes({ homePath, projectManager, worktreeManager });

    await expect((await app.request("/api/github/status")).json()).resolves.toEqual({
      installed: true,
      authenticated: true,
      user: "octocat",
      errorCode: null,
    });
    const res = await app.request(jsonRequest("/api/projects/repo/worktrees", { branch: "main" }));
    expect(res.status).toBe(201);
    expect(worktreeManager.createWorktree).toHaveBeenCalledWith({ projectSlug: "repo", branch: "main" });
  });
});
