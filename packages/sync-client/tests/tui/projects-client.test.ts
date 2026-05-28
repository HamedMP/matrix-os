import { describe, expect, it, vi } from "vitest";
import { createProjectsClient } from "../../src/cli/tui/projects.js";

describe("TUI projects/worktrees client", () => {
  it("routes project and worktree operations through gateway paths", async () => {
    const calls: string[] = [];
    const gateway = { requestJson: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/workspace/projects") return { projects: [{ slug: "repo", name: "Repo" }] };
      if (path === "/api/projects/repo/worktrees") return { worktrees: [{ id: "wt_abc", projectSlug: "repo" }] };
      return { project: { slug: "repo" }, worktree: { id: "wt_abc" } };
    }) };
    const client = createProjectsClient(gateway);

    await expect(client.listProjects()).resolves.toEqual([{ slug: "repo", name: "Repo" }]);
    await client.createProject({ url: "github.com/owner/repo" });
    await client.getProject("repo");
    await expect(client.listWorktrees("repo")).resolves.toEqual([{ id: "wt_abc", projectSlug: "repo" }]);
    await client.createWorktree("repo", { branch: "main" });
    await client.deleteWorktree("repo", "wt_abc");

    expect(calls).toEqual([
      "GET /api/workspace/projects",
      "POST /api/projects",
      "GET /api/projects/repo",
      "GET /api/projects/repo/worktrees",
      "POST /api/projects/repo/worktrees",
      "DELETE /api/projects/repo/worktrees/wt_abc",
    ]);
  });
});
