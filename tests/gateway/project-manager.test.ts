import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectManager, validateGitHubUrl } from "../../packages/gateway/src/project-manager.js";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";

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
      kind: "github",
      name: "Repo",
      slug: "repo",
      remote: "https://github.com/Owner/Repo.git",
      ownerScope: { type: "user", id: "user_123" },
      github: { owner: "Owner", repo: "Repo", authState: "ok" },
    });
    await expect(stat(join(homePath, "projects", "repo", "repo", ".git"))).resolves.toBeTruthy();
    const config = JSON.parse(await readFile(join(homePath, "system", "projects", "repo", "config.json"), "utf-8"));
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
      kind: "scratch",
      name: "Empty Workspace",
      slug: "empty-workspace",
      ownerScope: { type: "user", id: "user_123" },
    });
    expect(result.project.remote).toBeUndefined();
    expect(result.project.github).toBeUndefined();
    await expect(stat(join(homePath, "projects", "empty-workspace", "repo"))).resolves.toBeTruthy();
    const config = JSON.parse(await readFile(join(homePath, "system", "projects", "empty-workspace", "config.json"), "utf-8"));
    expect(config.localPath).toBe(join(homePath, "projects", "empty-workspace", "repo"));
  });

  it("rejects an oversized project description at the manager boundary", async () => {
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.createProject({
      mode: "scratch",
      name: "Oversized",
      description: "x".repeat(1_001),
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_project_description" },
    });
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

  it("publishes folder project config exclusively across manager instances", async () => {
    await mkdir(join(homePath, "workspaces", "shared"), { recursive: true });
    const firstManager = createProjectManager({ homePath, runCommand: vi.fn() });
    const secondManager = createProjectManager({ homePath, runCommand: vi.fn() });
    const input = {
      mode: "folder" as const,
      name: "Shared",
      path: "workspaces/shared",
      ownerScope: { type: "user" as const, id: "user_123" },
      clientRequestId: "req_folder_shared_1",
    };

    const [first, second] = await Promise.all([
      firstManager.createProject(input),
      secondManager.createProject(input),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected idempotent project creation");
    expect(second.project.id).toBe(first.project.id);
  });

  it("treats Git and GitHub as optional capabilities for folder projects", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") {
        const err = new Error("fatal: not a git repository") as Error & { stderr: string };
        err.stderr = "fatal: not a git repository (or any of the parent directories): .git";
        throw err;
      }
      return { stdout: "", stderr: "" };
    });
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
    expect(runCommand).not.toHaveBeenCalledWith("git", expect.arrayContaining(["branch"]), expect.any(Object));
  });

  it("reports local coding metadata without fetching the remote", async () => {
    const ownerScope = { type: "user" as const, id: "user_123" };
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe("git");
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return { stdout: `${join(homePath, "projects", "repo", "repo")}\n`, stderr: "" };
      }
      if (args.join(" ") === "status --porcelain --untracked-files=normal") {
        return { stdout: " M src/app.ts\n", stderr: "" };
      }
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "feature/project-cards\n", stderr: "" };
      }
      if (args.join(" ") === "rev-parse --abbrev-ref @{upstream}") {
        return { stdout: "origin/feature/project-cards\n", stderr: "" };
      }
      if (args.join(" ") === "rev-list --left-right --count @{upstream}...HEAD") {
        return { stdout: "2\t3\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });
    const manager = createProjectManager({ homePath, runCommand });
    const created = await manager.createProject({
      mode: "scratch",
      name: "Repo",
      slug: "repo",
      ownerScope,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await atomicWriteJson(
      join(homePath, "system", "projects", "repo", "config.json"),
      {
        ...created.project,
        kind: "github",
        remote: "https://github.com/Matrix-OS/repo.git",
        github: {
          owner: "Matrix-OS",
          repo: "repo",
          htmlUrl: "https://github.com/Matrix-OS/repo",
          authState: "ok",
        },
      },
    );

    await expect(manager.getCodeMetadata("repo", ownerScope)).resolves.toEqual({
      ok: true,
      path: join(homePath, "projects", "repo", "repo"),
      repository: "Matrix-OS/repo",
      isGitRepository: true,
      branch: "feature/project-cards",
      clean: false,
      ahead: 3,
      behind: 2,
      hasUpstream: true,
    });
    expect(runCommand.mock.calls.some(([, args]) => args.includes("fetch"))).toBe(false);
  });

  it("treats a detached HEAD as a repository without an upstream", async () => {
    const ownerScope = { type: "user" as const, id: "user_123" };
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe("git");
      const invocation = args.join(" ");
      if (invocation === "rev-parse --show-toplevel") {
        return { stdout: `${join(homePath, "projects", "detached", "repo")}\n`, stderr: "" };
      }
      if (invocation === "status --porcelain --untracked-files=normal") {
        return { stdout: "", stderr: "" };
      }
      if (invocation === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "HEAD\n", stderr: "" };
      }
      if (invocation === "rev-parse --abbrev-ref @{upstream}") {
        const error = new Error("git exited with code 128") as Error & { stderr: string };
        error.stderr = "fatal: HEAD does not point to a branch\n";
        throw error;
      }
      throw new Error(`Unexpected command: ${command} ${invocation}`);
    });
    const manager = createProjectManager({ homePath, runCommand });
    const created = await manager.createProject({
      mode: "scratch",
      name: "Detached",
      slug: "detached",
      ownerScope,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await atomicWriteJson(join(homePath, "system", "projects", "detached", "config.json"), {
      ...created.project,
      kind: "github",
      remote: "https://github.com/Matrix-OS/repo.git",
      github: {
        owner: "Matrix-OS",
        repo: "repo",
        htmlUrl: "https://github.com/Matrix-OS/repo",
        authState: "ok",
      },
    });

    await expect(manager.getCodeMetadata("detached", ownerScope)).resolves.toEqual({
      ok: true,
      path: join(homePath, "projects", "detached", "repo"),
      repository: "Matrix-OS/repo",
      isGitRepository: true,
      branch: null,
      clean: true,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    });
  });

  it("lists branches for a folder project nested inside a repository", async () => {
    const repoRoot = join(homePath, "workspaces", "monorepo");
    await mkdir(join(repoRoot, "packages", "app"), { recursive: true });
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { stdout: `${repoRoot}\n`, stderr: "" };
      if (command === "git" && args[0] === "branch") return { stdout: "main\nfeature\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const manager = createProjectManager({ homePath, runCommand, now: () => "2026-04-26T00:00:00.000Z" });
    await manager.createProject({
      mode: "folder",
      name: "Monorepo app",
      slug: "monorepo-app",
      path: "workspaces/monorepo/packages/app",
    });

    await expect(manager.listBranches("monorepo-app")).resolves.toMatchObject({
      ok: true,
      branches: [{ name: "main" }, { name: "feature" }],
    });
  });

  it("does not show home-versioning branches for plain folders", async () => {
    await mkdir(join(homePath, "workspaces", "notes"), { recursive: true });
    // The Matrix home itself is a versioned Git repo: a folder that resolves
    // to it as its repository toplevel has no project branches to show.
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { stdout: `${homePath}\n`, stderr: "" };
      return { stdout: "main\n", stderr: "" };
    });
    const manager = createProjectManager({ homePath, runCommand, now: () => "2026-04-26T00:00:00.000Z" });
    await manager.createProject({
      mode: "folder",
      name: "Notes",
      slug: "notes-folder",
      path: "workspaces/notes",
    });

    await expect(manager.listBranches("notes-folder")).resolves.toEqual({
      ok: true,
      branches: [],
      refreshedAt: "2026-04-26T00:00:00.000Z",
    });
    expect(runCommand).not.toHaveBeenCalledWith("git", expect.arrayContaining(["branch"]), expect.any(Object));
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

    // The stored localPath is the fully resolved path so later symlink
    // repoints cannot bypass the create-time validation.
    expect(created).toMatchObject({
      ok: true,
      project: { kind: "folder", localPath: await realpath(existing) },
    });
    if (created.ok) expect(created.project.github).toBeUndefined();
    await expect(manager.removeManagedProject({
      slug: "customer-app",
      ownerScope: { type: "user", id: "user_123" },
    })).resolves.toEqual({ ok: true });
    await expect(readFile(join(existing, "README.md"), "utf-8")).resolves.toBe("owner data");
  });

  it("removes validated legacy Matrix state when deleting a folder project", async () => {
    const existing = join(homePath, "workspaces", "legacy-state-folder");
    const legacyTask = join(
      homePath,
      "projects",
      "legacy-state-folder",
      "tasks",
      "task_owned123.json",
    );
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "README.md"), "owner data");
    const manager = createProjectManager({ homePath, runCommand: vi.fn(), now: () => "2026-04-26T00:00:00.000Z" });
    await manager.createProject({
      mode: "folder",
      name: "Legacy state folder",
      slug: "legacy-state-folder",
      path: "workspaces/legacy-state-folder",
      ownerScope: { type: "user", id: "user_123" },
    });
    await atomicWriteJson(legacyTask, {
      id: "task_owned123",
      projectSlug: "legacy-state-folder",
      title: "Owned task",
      status: "todo",
      priority: "normal",
      order: 0,
      previewIds: [],
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    });

    await expect(manager.removeManagedProject({
      slug: "legacy-state-folder",
      ownerScope: { type: "user", id: "user_123" },
    })).resolves.toEqual({ ok: true });

    await expect(stat(legacyTask)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(existing, "README.md"), "utf-8")).resolves.toBe("owner data");
  });

  it("connects a checkout directly under projects while keeping registry metadata in system", async () => {
    const checkout = join(homePath, "projects", "matrix-os-repo");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "README.md"), "owner checkout");
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    const created = await manager.createProject({
      mode: "folder",
      name: "Matrix OS repo",
      slug: "matrix-os-repo",
      path: "projects/matrix-os-repo",
      ownerScope: { type: "user", id: "user_123" },
    });

    expect(created).toMatchObject({
      ok: true,
      status: 201,
      project: { localPath: await realpath(checkout) },
    });
    await expect(readFile(join(checkout, "README.md"), "utf-8")).resolves.toBe("owner checkout");
    await expect(stat(join(checkout, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const config = JSON.parse(
      await readFile(join(homePath, "system", "projects", "matrix-os-repo", "config.json"), "utf-8"),
    );
    expect(config).toMatchObject({ slug: "matrix-os-repo", localPath: await realpath(checkout) });
  });

  it("allows an idempotent retry after connecting a checkout directly under projects", async () => {
    const checkout = join(homePath, "projects", "retry-repo");
    await mkdir(checkout, { recursive: true });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const request = {
      mode: "folder" as const,
      name: "Retry repo",
      slug: "retry-repo",
      path: "projects/retry-repo",
      ownerScope: { type: "user" as const, id: "user_123" },
      clientRequestId: "req_retry_repo",
    };

    await expect(manager.createProject(request)).resolves.toMatchObject({ ok: true, status: 201 });
    await expect(manager.createProject(request)).resolves.toMatchObject({
      ok: true,
      status: 200,
      project: { slug: "retry-repo", kind: "folder", localPath: await realpath(checkout) },
    });
  });

  it("does not mistake an owner repository config.json for legacy Matrix metadata", async () => {
    const checkout = join(homePath, "projects", "configured-repo");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "config.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    const created = await manager.createProject({
      mode: "folder",
      name: "Configured repo",
      slug: "configured-repo",
      path: "projects/configured-repo",
      ownerScope: { type: "user", id: "user_123" },
    });

    expect(created).toMatchObject({ ok: true, status: 201 });
    await expect(readFile(join(checkout, "config.json"), "utf-8"))
      .resolves.toContain("compilerOptions");
    await expect(manager.listManagedProjects({ ownerScope: { type: "user", id: "user_123" } }))
      .resolves.toMatchObject({ projects: [{ slug: "configured-repo" }] });
  });

  it("preserves an owner config.json that happens to contain id and slug fields", async () => {
    const checkout = join(homePath, "projects", "configured-app");
    const ownerConfig = {
      id: "configured-app",
      slug: "configured-app",
      theme: "dark",
    };
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "config.json"), JSON.stringify(ownerConfig));
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    const created = await manager.createProject({
      mode: "folder",
      name: "Configured app",
      slug: "configured-app",
      path: "projects/configured-app",
      ownerScope: { type: "user", id: "user_123" },
    });

    expect(created).toMatchObject({ ok: true, status: 201 });
    await expect(readFile(join(checkout, "config.json"), "utf-8"))
      .resolves.toBe(JSON.stringify(ownerConfig));
    await expect(readFile(
      join(homePath, "system", "projects", "configured-app", "config.json"),
      "utf-8",
    )).resolves.toContain('"kind": "folder"');
  });

  it("returns owner-scoped active and archived project projections without exposing deletion tombstones", async () => {
    const projects = [
      {
        slug: "active-project",
        name: "Active project",
        ownerScope: { type: "user", id: "user_123" },
      },
      {
        slug: "archived-project",
        name: "Archived project",
        ownerScope: { type: "user", id: "user_123" },
        archivedAt: "2026-08-06T12:00:00.000Z",
      },
      {
        slug: "deleting-project",
        name: "Deleting project",
        ownerScope: { type: "user", id: "user_123" },
        deletingAt: "2026-08-06T12:01:00.000Z",
      },
      {
        slug: "another-owner-project",
        name: "Another owner project",
        ownerScope: { type: "user", id: "user_456" },
      },
    ] as const;

    for (const project of projects) {
      const root = join(homePath, "projects", project.slug);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "config.json"), JSON.stringify({
        id: `proj_${project.slug}`,
        name: project.name,
        slug: project.slug,
        kind: "scratch",
        localPath: join(root, "repo"),
        addedAt: "2026-08-06T10:00:00.000Z",
        updatedAt: "2026-08-06T10:00:00.000Z",
        ownerScope: project.ownerScope,
        ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
        ...(project.deletingAt ? { deletingAt: project.deletingAt } : {}),
      }));
    }

    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const ownerScope = { type: "user" as const, id: "user_123" };

    await expect(manager.listManagedProjects({ visibility: "active", ownerScope })).resolves.toMatchObject({
      projects: [{ slug: "active-project" }],
    });
    await expect(manager.listManagedProjects({ visibility: "archived", ownerScope })).resolves.toMatchObject({
      projects: [{ slug: "archived-project" }],
    });
    await expect(manager.listManagedProjects({ visibility: "all", ownerScope })).resolves.toMatchObject({
      projects: expect.arrayContaining([
        expect.objectContaining({ slug: "active-project" }),
        expect.objectContaining({ slug: "archived-project" }),
      ]),
    });
    const all = await manager.listManagedProjects({ visibility: "all", ownerScope });
    expect(all.projects.map((project) => project.slug).sort()).toEqual(["active-project", "archived-project"]);
    await expect(manager.listDeletingProjects()).resolves.toMatchObject({
      projects: [{ slug: "deleting-project", deletingAt: "2026-08-06T12:01:00.000Z" }],
    });
  });

  it("rejects a missing persisted project path beneath a symlinked outside ancestor", async () => {
    await symlink(tmpdir(), join(homePath, "outside-alias"));
    await atomicWriteJson(join(homePath, "system", "projects", "escaped", "config.json"), {
      id: "proj_escaped",
      name: "Escaped",
      slug: "escaped",
      kind: "folder",
      localPath: join(homePath, "outside-alias", "not-created-yet"),
      addedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.listManagedProjects({
      visibility: "active",
      ownerScope: { type: "user", id: "user_123" },
    })).resolves.toEqual({ projects: [], nextCursor: null });
  });

  it("classifies legacy project records without making the renderer infer their kind", async () => {
    const root = join(homePath, "projects", "legacy-scratch");
    await mkdir(join(root, "repo"), { recursive: true });
    await writeFile(join(root, "config.json"), JSON.stringify({
      id: "proj_legacy",
      name: "Legacy scratch",
      slug: "legacy-scratch",
      localPath: join(root, "repo"),
      addedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    }));

    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const result = await manager.listManagedProjects({
      visibility: "active",
      ownerScope: { type: "user", id: "user_123" },
    });

    expect(result.projects).toMatchObject([{ slug: "legacy-scratch", kind: "scratch" }]);
  });

  it("adopts a legacy registry record once without moving its workspace", async () => {
    const root = join(homePath, "projects", "legacy-repo");
    const workspace = join(root, "repo");
    await mkdir(workspace, { recursive: true });
    const legacy = {
      id: "proj_legacy_repo",
      name: "Legacy repo",
      slug: "legacy-repo",
      kind: "github" as const,
      localPath: workspace,
      addedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      ownerScope: { type: "user" as const, id: "user_123" },
      padding: "owner application field",
    };
    await writeFile(join(root, "config.json"), JSON.stringify(legacy));
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    const first = await manager.getProject("legacy-repo");
    const second = await manager.getProject("legacy-repo");

    expect(first).toMatchObject({ ok: true, project: { id: "proj_legacy_repo", localPath: workspace } });
    expect(second).toEqual(first);
    await expect(stat(workspace)).resolves.toBeTruthy();
    await expect(stat(join(root, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(homePath, "system", "projects", "legacy-repo", "config.json"), "utf-8"),
    ).resolves.toContain("proj_legacy_repo");
    await expect(
      readFile(join(homePath, "system", "projects", "legacy-repo", "legacy-config.json"), "utf-8"),
    ).resolves.toContain("proj_legacy_repo");
    const canonical = JSON.parse(await readFile(
      join(homePath, "system", "projects", "legacy-repo", "config.json"),
      "utf-8",
    ));
    expect(canonical).not.toHaveProperty("padding");
  });

  it("refuses to adopt an oversized legacy project record", async () => {
    const root = join(homePath, "projects", "oversized-legacy");
    const workspace = join(root, "repo");
    await mkdir(workspace, { recursive: true });
    await atomicWriteJson(join(root, "config.json"), {
      id: "proj_oversized_legacy",
      name: "Oversized legacy",
      slug: "oversized-legacy",
      kind: "github",
      localPath: workspace,
      addedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
      padding: "x".repeat(300 * 1024),
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.getProject("oversized-legacy")).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
    await expect(stat(join(homePath, "system", "projects", "oversized-legacy", "config.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps legacy deletion tombstones recoverable and adopts them into the registry", async () => {
    const tombstone = {
      id: "proj_deleting_legacy",
      name: "Deleting legacy",
      slug: "deleting-legacy",
      kind: "scratch" as const,
      localPath: join(homePath, "projects", "deleting-legacy", "repo"),
      addedAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      deletingAt: "2026-08-17T00:00:00.000Z",
      ownerScope: { type: "user" as const, id: "user_123" },
    };
    await atomicWriteJson(join(homePath, "projects", ".deleting", "deleting-legacy.json"), tombstone);
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.listDeletingProjects()).resolves.toMatchObject({
      projects: [expect.objectContaining({ slug: "deleting-legacy", deletingAt: tombstone.deletingAt })],
    });
    await expect(readFile(
      join(homePath, "system", "projects", ".deleting", "deleting-legacy.json"),
      "utf-8",
    )).resolves.toContain("Deleting legacy");
  });

  it("keeps a conflicting legacy record for operator recovery while preferring canonical state", async () => {
    const legacyRoot = join(homePath, "projects", "conflicted-repo");
    const workspace = join(legacyRoot, "repo");
    await mkdir(workspace, { recursive: true });
    await atomicWriteJson(join(legacyRoot, "config.json"), {
      id: "proj_legacy_conflict",
      name: "Legacy conflict",
      slug: "conflicted-repo",
      kind: "github",
      localPath: workspace,
      addedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    });
    await atomicWriteJson(join(homePath, "system", "projects", "conflicted-repo", "config.json"), {
      id: "proj_canonical_conflict",
      name: "Canonical conflict",
      slug: "conflicted-repo",
      kind: "folder",
      localPath: workspace,
      addedAt: "2026-08-02T10:00:00.000Z",
      updatedAt: "2026-08-02T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.getProject("conflicted-repo")).resolves.toMatchObject({
      ok: true,
      project: { id: "proj_canonical_conflict", name: "Canonical conflict" },
    });
    await expect(readFile(join(legacyRoot, "config.json"), "utf-8"))
      .resolves.toContain("proj_legacy_conflict");
    await expect(stat(join(homePath, "system", "projects", "conflicted-repo", "legacy-config.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates lifecycle state only for the owning scope and persists legacy kind classification", async () => {
    const root = join(homePath, "projects", "legacy-owned");
    await mkdir(join(root, "repo"), { recursive: true });
    await writeFile(join(root, "config.json"), JSON.stringify({
      id: "proj_legacy_owned",
      name: "Legacy owned",
      slug: "legacy-owned",
      localPath: join(root, "repo"),
      addedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    }));
    const manager = createProjectManager({
      homePath,
      runCommand: vi.fn(),
      now: () => "2026-08-06T12:00:00.000Z",
    });

    await expect(manager.setProjectLifecycleState({
      slug: "legacy-owned",
      ownerScope: { type: "user", id: "user_456" },
      archivedAt: "2026-08-06T12:00:00.000Z",
    })).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(manager.setProjectLifecycleState({
      slug: "legacy-owned",
      ownerScope: { type: "user", id: "user_123" },
      archivedAt: "2026-08-06T12:00:00.000Z",
    })).resolves.toMatchObject({
      ok: true,
      project: {
        slug: "legacy-owned",
        kind: "scratch",
        archivedAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:00:00.000Z",
      },
    });

    const persisted = JSON.parse(await readFile(
      join(homePath, "system", "projects", "legacy-owned", "config.json"),
      "utf-8",
    ));
    expect(persisted).toMatchObject({ kind: "scratch", archivedAt: "2026-08-06T12:00:00.000Z" });
  });

  it("preserves a conflicting tombstone when the authorized project clears deletion state", async () => {
    const workspace = join(homePath, "workspaces", "repo");
    await mkdir(workspace, { recursive: true });
    const config = {
      id: "proj_owner_a",
      name: "Owner A",
      slug: "repo",
      kind: "folder",
      localPath: workspace,
      addedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    };
    const tombstonePath = join(homePath, "system", "projects", ".deleting", "repo.json");
    await atomicWriteJson(join(homePath, "system", "projects", "repo", "config.json"), config);
    await atomicWriteJson(tombstonePath, {
      ...config,
      id: "proj_owner_b",
      name: "Owner B",
      ownerScope: { type: "user", id: "user_b" },
      deletingAt: "2026-08-06T11:00:00.000Z",
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.setProjectLifecycleState({
      slug: "repo",
      ownerScope: { type: "user", id: "user_a" },
      deletingAt: null,
    })).resolves.toMatchObject({ ok: true });

    await expect(readFile(tombstonePath, "utf-8")).resolves.toContain("proj_owner_b");
  });

  it("preserves a legacy tombstone owned by another scope when setting deletion state", async () => {
    const workspace = join(homePath, "workspaces", "repo");
    await mkdir(workspace, { recursive: true });
    const config = {
      id: "proj_shared_id",
      name: "Owner A",
      slug: "repo",
      kind: "folder",
      localPath: workspace,
      addedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    };
    const legacyTombstonePath = join(homePath, "projects", ".deleting", "repo.json");
    await atomicWriteJson(join(homePath, "system", "projects", "repo", "config.json"), config);
    await atomicWriteJson(legacyTombstonePath, {
      ...config,
      name: "Owner B",
      ownerScope: { type: "user", id: "user_b" },
      deletingAt: "2026-08-06T11:00:00.000Z",
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.setProjectLifecycleState({
      slug: "repo",
      ownerScope: { type: "user", id: "user_a" },
      deletingAt: "2026-08-06T12:00:00.000Z",
    })).resolves.toMatchObject({ ok: true });

    await expect(readFile(legacyTombstonePath, "utf-8")).resolves.toContain("user_b");
  });

  it("never recursively deletes owner source for a kindless legacy project", async () => {
    const source = join(homePath, "projects", "legacy-kindless");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "owner source");
    await atomicWriteJson(join(homePath, "system", "projects", "legacy-kindless", "config.json"), {
      id: "proj_legacy_kindless",
      name: "Legacy kindless",
      slug: "legacy-kindless",
      localPath: source,
      addedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.setProjectLifecycleState({
      slug: "legacy-kindless",
      ownerScope: { type: "user", id: "user_123" },
      deletingAt: "2026-08-18T00:00:00.000Z",
    })).resolves.toMatchObject({ ok: true });
    await expect(manager.removeManagedProject({
      slug: "legacy-kindless",
      ownerScope: { type: "user", id: "user_123" },
    })).resolves.toEqual({ ok: true });

    await expect(readFile(join(source, "README.md"), "utf-8")).resolves.toBe("owner source");
    await expect(stat(join(homePath, "system", "projects", "legacy-kindless")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a same-slug owner folder when managed kind and local path disagree", async () => {
    const ownerFolder = join(homePath, "projects", "mismatched");
    const recordedSource = join(homePath, "projects", "elsewhere", "repo");
    await mkdir(ownerFolder, { recursive: true });
    await mkdir(recordedSource, { recursive: true });
    await writeFile(join(ownerFolder, "keep.txt"), "owner source");
    await atomicWriteJson(join(homePath, "system", "projects", "mismatched", "config.json"), {
      id: "proj_mismatched",
      name: "Mismatched",
      slug: "mismatched",
      kind: "github",
      localPath: recordedSource,
      addedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.removeManagedProject({
      slug: "mismatched",
      ownerScope: { type: "user", id: "user_123" },
    })).resolves.toEqual({ ok: true });

    await expect(readFile(join(ownerFolder, "keep.txt"), "utf-8")).resolves.toBe("owner source");
    await expect(stat(join(homePath, "system", "projects", "mismatched")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only the owned Matrix project registry and preserves a folder project's source directory", async () => {
    const external = join(homePath, "workspaces", "external-project");
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel.txt"), "owner-controlled");
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const created = await manager.createProject({
      mode: "folder",
      name: "External project",
      slug: "external-project",
      path: "workspaces/external-project",
      ownerScope: { type: "user", id: "user_123" },
    });
    expect(created.ok).toBe(true);

    await expect(manager.removeManagedProject({
      slug: "external-project",
      ownerScope: { type: "user", id: "user_456" },
    })).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(manager.removeManagedProject({
      slug: "external-project",
      ownerScope: { type: "user", id: "user_123" },
    })).resolves.toEqual({ ok: true });

    await expect(stat(join(homePath, "projects", "external-project"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(external, "sentinel.txt"), "utf-8")).resolves.toBe("owner-controlled");
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
    await mkdir(join(homePath, ".hermes"), { recursive: true });
    await mkdir(join(homePath, ".claude"), { recursive: true });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    for (const path of [".", "system", "system/wallpapers", "agents", "agents/custom", ".trash", ".hermes", ".claude"]) {
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
    await atomicWriteJson(join(homePath, "system", "projects", "other", "config.json"), {
      id: "proj_other",
      name: "Other",
      slug: "other",
      kind: "scratch",
      localPath: join(homePath, "projects", "other"),
      addedAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      ownerScope: { type: "user", id: "local" },
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    await expect(manager.createProject({
      mode: "folder",
      name: "Other copy",
      slug: "other-copy",
      path: "projects/other",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });

    // A repo checkout nested inside a managed project stays connectable: it
    // contains no registry metadata.
    await mkdir(join(homePath, "projects", "other", "repo", "src"), { recursive: true });
    await expect(manager.createProject({
      mode: "folder",
      name: "Other repo",
      slug: "other-repo",
      path: "projects/other/repo",
    })).resolves.toMatchObject({ ok: true, status: 201 });
    await expect(manager.createProject({
      mode: "folder",
      name: "Other repo src",
      slug: "other-repo-src",
      path: "projects/other/repo/src",
    })).resolves.toMatchObject({ ok: true, status: 201 });
  });

  it("rejects ancestors of denied subtrees while allowing sibling folders", async () => {
    await mkdir(join(homePath, "data", "browser-profiles"), { recursive: true });
    await mkdir(join(homePath, "data", "exports"), { recursive: true });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    // data contains data/browser-profiles (persistent browser login state).
    await expect(manager.createProject({
      mode: "folder",
      name: "Data",
      slug: "data-root",
      path: "data",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });

    await expect(manager.createProject({
      mode: "folder",
      name: "Exports",
      slug: "data-exports",
      path: "data/exports",
    })).resolves.toMatchObject({ ok: true, status: 201 });
  });

  it("rejects managed worktree and metadata areas as folder project roots", async () => {
    await mkdir(join(homePath, "projects", "other", "worktrees", "wt-1"), { recursive: true });
    await atomicWriteJson(join(homePath, "system", "projects", "other", "config.json"), {
      id: "proj_other",
      name: "Other",
      slug: "other",
      kind: "scratch",
      localPath: join(homePath, "projects", "other"),
      addedAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      ownerScope: { type: "user", id: "local" },
    });
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });

    for (const path of ["projects/other/worktrees", "projects/other/worktrees/wt-1"]) {
      await expect(manager.createProject({
        mode: "folder",
        name: "Worktree",
        slug: `worktree-${path.split("/").length}`,
        path,
      })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_project_path" } });
    }
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
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: `${join(homePath, "projects", "repo", "repo")}\n`, stderr: "" };
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
