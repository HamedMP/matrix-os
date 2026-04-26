import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectManager, validateGitHubUrl } from "../../packages/gateway/src/project-manager.js";

describe("project-manager", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-project-manager-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("validates GitHub URLs without accepting command-shaped or non-GitHub input", () => {
    expect(validateGitHubUrl("github.com/Matrix-OS/core.repo.git")).toMatchObject({
      ok: true,
      owner: "Matrix-OS",
      repo: "core.repo",
    });
    expect(validateGitHubUrl("https://github.com/owner/repo")).toMatchObject({ ok: true });
    expect(validateGitHubUrl("git@github.com:owner/repo.git")).toMatchObject({ ok: true });

    expect(validateGitHubUrl("https://example.com/owner/repo")).toMatchObject({
      ok: false,
      code: "invalid_repository_url",
    });
    expect(validateGitHubUrl("github.com/owner/repo;rm -rf /")).toMatchObject({
      ok: false,
      code: "invalid_repository_url",
    });
  });

  it("creates a project through safe clone staging and writes owner-scoped config", async () => {
    const runCommand = vi.fn(async (command: string, args: string[], options) => {
      expect(command).toMatch(/^(gh|git)$/);
      expect(args).not.toContain(";");
      if (command === "git" && args[0] === "clone") {
        const destination = args.at(-1);
        expect(typeof destination).toBe("string");
        await mkdir(join(destination as string, ".git"), { recursive: true });
      }
      return { stdout: "", stderr: "" };
    });
    const manager = createProjectManager({ homePath, runCommand, now: () => "2026-04-26T00:00:00.000Z" });

    const result = await manager.createProject({
      url: "https://github.com/Owner/Repo.git",
      ownerScope: { type: "user", id: "user_123" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project).toMatchObject({
      name: "Repo",
      slug: "repo",
      remote: "https://github.com/Owner/Repo.git",
      ownerScope: { type: "user", id: "user_123" },
      github: { owner: "Owner", repo: "Repo", authState: "ok" },
    });
    await expect(stat(join(homePath, "projects", "repo", "repo", ".git"))).resolves.toBeTruthy();
    const config = JSON.parse(await readFile(join(homePath, "projects", "repo", "config.json"), "utf-8"));
    expect(config.localPath).toBe(join(homePath, "projects", "repo", "repo"));
  });

  it("rejects slug conflicts before cloning", async () => {
    await mkdir(join(homePath, "projects", "repo"), { recursive: true });
    const runCommand = vi.fn();
    const manager = createProjectManager({ homePath, runCommand });

    const result = await manager.createProject({ url: "github.com/owner/repo", slug: "repo" });

    expect(result).toMatchObject({ ok: false, status: 409, error: { code: "slug_conflict" } });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("cleans clone staging on failure without exposing raw command errors", async () => {
    const runCommand = vi.fn(async (command: string, args: string[], options) => {
      if (command === "git" && args[0] === "clone") {
        await mkdir(options.cwd, { recursive: true });
        throw new Error("fatal: token ghp_secret leaked");
      }
      return { stdout: "", stderr: "" };
    });
    const manager = createProjectManager({ homePath, runCommand });

    const result = await manager.createProject({ url: "github.com/owner/repo" });

    expect(result).toMatchObject({ ok: false, status: 502, error: { code: "clone_failed" } });
    if (!result.ok) {
      expect(result.error.message).toBe("Repository clone failed");
      expect(result.error.message).not.toContain("ghp_secret");
    }
    await expect(readdir(join(homePath, "system", "clone-staging"))).resolves.toEqual([]);
  });

  it("lists PRs and branches through argv-based commands", async () => {
    await mkdir(join(homePath, "projects", "repo", "repo", ".git"), { recursive: true });
    await mkdir(join(homePath, "projects", "repo"), { recursive: true });
    await import("../../packages/gateway/src/state-ops.js").then(({ atomicWriteJson }) =>
      atomicWriteJson(join(homePath, "projects", "repo", "config.json"), {
        id: "proj_repo",
        name: "repo",
        slug: "repo",
        localPath: join(homePath, "projects", "repo", "repo"),
        addedAt: "2026-04-26T00:00:00.000Z",
        updatedAt: "2026-04-26T00:00:00.000Z",
        ownerScope: { type: "user", id: "local" },
        github: { owner: "owner", repo: "repo", htmlUrl: "https://github.com/owner/repo", authState: "ok" },
      }),
    );
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "gh" && args[0] === "pr") {
        return { stdout: JSON.stringify([{ number: 7, title: "Fix", author: { login: "octo" }, headRefName: "fix", baseRefName: "main", state: "OPEN" }]), stderr: "" };
      }
      if (command === "git" && args[0] === "branch") {
        return { stdout: "main\nfeature\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const manager = createProjectManager({ homePath, runCommand });

    await expect(manager.listPullRequests("repo")).resolves.toMatchObject({
      ok: true,
      prs: [{ number: 7, title: "Fix", author: "octo", headRef: "fix", baseRef: "main", state: "OPEN" }],
    });
    await expect(manager.listBranches("repo")).resolves.toMatchObject({
      ok: true,
      branches: [{ name: "main" }, { name: "feature" }],
    });
    expect(runCommand).toHaveBeenCalledWith("gh", expect.arrayContaining(["--repo", "owner/repo"]), expect.any(Object));
  });
});
