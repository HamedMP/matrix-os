import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

function makeApp(listGithubRepos: ReturnType<typeof vi.fn>) {
  const projectManager = {
    listGithubRepos,
    getGithubStatus: vi.fn(),
    createProject: vi.fn(),
    listManagedProjects: vi.fn(),
    getProject: vi.fn(),
    deleteProject: vi.fn(),
    listPullRequests: vi.fn(),
    listBranches: vi.fn(),
  } as any;
  return createWorkspaceRoutes({
    homePath: "/tmp/test-home",
    projectManager,
    getOwnerScope: () => ({ type: "user" as const, id: "user_123" }),
  });
}

describe("GET /api/github/repos", () => {
  it("returns a capped, validated repo list", async () => {
    const listGithubRepos = vi.fn(async () => ({
      repos: [
        {
          nameWithOwner: "acme/api",
          url: "https://github.com/acme/api",
          description: "API",
          primaryLanguage: "TypeScript",
          stargazerCount: 1200,
          updatedAt: "2026-06-20T00:00:00Z",
        },
      ],
    }));
    const app = makeApp(listGithubRepos);
    const res = await app.request("/api/github/repos?search=api&limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos[0].nameWithOwner).toBe("acme/api");
    expect(listGithubRepos).toHaveBeenCalledWith({ search: "api", limit: 10 });
  });

  it("clamps an over-large limit and defaults search", async () => {
    const listGithubRepos = vi.fn(async () => ({ repos: [] }));
    const app = makeApp(listGithubRepos);
    await app.request("/api/github/repos?limit=9999");
    expect(listGithubRepos).toHaveBeenCalledWith({ search: undefined, limit: 50 });
  });

  it("returns a generic 502 when gh fails (no raw error leak)", async () => {
    const listGithubRepos = vi.fn(async () => {
      throw new Error("gh: secret token in stderr");
    });
    const app = makeApp(listGithubRepos);
    const res = await app.request("/api/github/repos");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("secret token");
  });
});
