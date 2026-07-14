import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

  it("creates a scratch project without GitHub auth or clone commands", async () => {
    const runCommand = vi.fn();
    const manager = createProjectManager({ homePath, runCommand, now: () => "2026-04-26T00:00:00.000Z" });

    const result = await manager.createProject({
      mode: "scratch",
      name: "Empty Workspace",
      slug: "empty-workspace",
      ownerScope: { type: "user", id: "user_123" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runCommand).not.toHaveBeenCalled();
    expect(result.project).toMatchObject({
      name: "Empty Workspace",
      slug: "empty-workspace",
      ownerScope: { type: "user", id: "user_123" },
    });
    expect(result.project.remote).toBeUndefined();
    expect(result.project.github).toBeUndefined();
    await expect(stat(join(homePath, "projects", "empty-workspace", "repo"))).resolves.toBeTruthy();
    const config = JSON.parse(await readFile(join(homePath, "projects", "empty-workspace", "config.json"), "utf-8"));
    expect(config.localPath).toBe(join(homePath, "projects", "empty-workspace", "repo"));
  });

  it("returns the same project for an idempotent create request", async () => {
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const input = {
      mode: "scratch" as const,
      name: "Mobile Workspace",
      slug: "mobile-workspace",
      ownerScope: { type: "user" as const, id: "user_123" },
      clientRequestId: "req_mobile_workspace_1",
    };

    const first = await manager.createProject(input);
    const repeated = await manager.createProject(input);
    const changedPayload = await manager.createProject({ ...input, name: "Different Workspace" });

    expect(first).toMatchObject({ ok: true, status: 201 });
    expect(repeated).toMatchObject({
      ok: true,
      status: 200,
      project: { slug: "mobile-workspace", createRequestId: "req_mobile_workspace_1" },
    });
    expect(changedPayload).toMatchObject({ ok: false, status: 409 });
  });

  it("treats Git and GitHub as optional capabilities for folder projects", async () => {
    const runCommand = vi.fn();
    const manager = createProjectManager({ homePath, runCommand, now: () => "2026-04-26T00:00:00.000Z" });
    const created = await manager.createProject({
      mode: "scratch",
      name: "Plain folder",
      slug: "plain-folder",
      ownerScope: { type: "user", id: "user_123" },
    });
    expect(created.ok).toBe(true);

    await expect(manager.listPullRequests("plain-folder")).resolves.toEqual({
      ok: true,
      prs: [],
      refreshedAt: "2026-04-26T00:00:00.000Z",
    });
    await expect(manager.listBranches("plain-folder")).resolves.toEqual({
      ok: true,
      branches: [],
      refreshedAt: "2026-04-26T00:00:00.000Z",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("connects a project to an existing owner folder without moving or deleting it", async () => {
    const existing = join(homePath, "workspaces", "customer-app");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "README.md"), "owner data");
    const manager = createProjectManager({ homePath, runCommand: vi.fn(), now: () => "2026-04-26T00:00:00.000Z" });

    const created = await manager.createProject({
      mode: "folder",
      name: "Customer app",
      slug: "customer-app",
      path: "workspaces/customer-app",
      ownerScope: { type: "user", id: "user_123" },
    });

    expect(created).toMatchObject({
      ok: true,
      project: { localPath: existing },
    });
    if (created.ok) expect(created.project.github).toBeUndefined();
    await expect(manager.deleteProject("customer-app")).resolves.toEqual({ ok: true });
    await expect(readFile(join(existing, "README.md"), "utf-8")).resolves.toBe("owner data");
  });

  it("rejects project folders outside the Matrix home", async () => {
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    await expect(manager.createProject({
      mode: "folder",
      name: "Outside",
      path: "../../outside",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });
  });

  it("rejects the home root and protected OS subtrees as folder projects", async () => {
    await mkdir(join(homePath, "system", "wallpapers"), { recursive: true });
    await mkdir(join(homePath, "agents", "custom"), { recursive: true });
    await mkdir(join(homePath, ".trash"), { recursive: true });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    for (const path of [".", "system", "system/wallpapers", "agents", "agents/custom", ".trash"]) {
      await expect(manager.createProject({
        mode: "folder",
        name: "Protected",
        slug: `protected-${path.replace(/[^a-z0-9]+/g, "-")}`,
        path,
      })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });
    }
  });

  it("rejects symlinked aliases of protected subtrees as folder projects", async () => {
    await mkdir(join(homePath, "system", "wallpapers"), { recursive: true });
    await symlink(join(homePath, "system"), join(homePath, "alias"));
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.createProject({
      mode: "folder",
      name: "Alias",
      slug: "alias-project",
      path: "alias/wallpapers",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });
  });

  it("rejects the Matrix project registry as a folder project root", async () => {
    await mkdir(join(homePath, "projects"), { recursive: true });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.createProject({
      mode: "folder",
      name: "Registry",
      slug: "registry",
      path: "projects",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });
  });

  it("rejects other managed project roots as folder projects", async () => {
    await mkdir(join(homePath, "projects", "other"), { recursive: true });
    await writeFile(join(homePath, "projects", "other", "config.json"), "{}");
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.createProject({
      mode: "folder",
      name: "Other copy",
      slug: "other-copy",
      path: "projects/other",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });

    // A repo checkout nested inside a managed project stays connectable: it
    // contains no registry metadata.
    await mkdir(join(homePath, "projects", "other", "repo"), { recursive: true });
    await expect(manager.createProject({
      mode: "folder",
      name: "Other repo",
      slug: "other-repo",
      path: "projects/other/repo",
    })).resolves.toMatchObject({ ok: true, status: 201 });
  });

  it("requires existing folder project paths to be directories", async () => {
    await writeFile(join(homePath, "notes.txt"), "owner notes");
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.createProject({
      mode: "folder",
      name: "Notes",
      slug: "notes",
      path: "notes.txt",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });
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
    await expect(stat(join(homePath, "projects", "repo"))).rejects.toMatchObject({ code: "ENOENT" });
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
