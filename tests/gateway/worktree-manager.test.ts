import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";

describe("worktree-manager", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-worktree-manager-"));
    await mkdir(join(homePath, "projects", "repo", "repo", ".git"), { recursive: true });
    await atomicWriteJson(join(homePath, "projects", "repo", "config.json"), {
      id: "proj_repo",
      slug: "repo",
      name: "repo",
      localPath: join(homePath, "projects", "repo", "repo"),
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "local" },
    });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates stable opaque worktree IDs for PR and branch refs", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      expect(args.join(" ")).not.toContain(";rm");
      return { stdout: "", stderr: "" };
    });
    const manager = createWorktreeManager({ homePath, runCommand, now: () => "2026-04-26T00:00:00.000Z" });

    const first = await manager.createWorktree({ projectSlug: "repo", pr: 42 });
    const second = await manager.createWorktree({ projectSlug: "repo", pr: 42 });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.worktree.id).toMatch(/^wt_[a-z0-9]+$/);
    expect(first.worktree.id).toBe(second.worktree.id);
    expect(first.worktree.currentBranch).toBe("pr-42");
    const metadata = JSON.parse(await readFile(join(first.worktree.path, ".matrix", "worktree.json"), "utf-8"));
    expect(metadata.pr.number).toBe(42);
  });

  it("fetches GitHub PR refs before creating a PR worktree", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", pr: 42 });

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["fetch", "origin", "pull/42/head:refs/heads/pr-42"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(2, "git", ["worktree", "add", "--", expect.any(String), "pr-42"], expect.any(Object));
  });

  it("creates a missing branch worktree from the project base ref when requested", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse") throw new Error("missing branch");
      return { stdout: "", stderr: "" };
    });
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", branch: "symphony/mat-1", createBranch: true });

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--verify", "--quiet", "refs/heads/symphony/mat-1"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/symphony/mat-1"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(3, "git", ["worktree", "add", "-b", "symphony/mat-1", "--", expect.any(String), "main"], expect.any(Object));
  });

  it("tracks an existing remote branch when creating a missing local branch worktree", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[3] === "refs/heads/symphony/mat-1") throw new Error("missing local branch");
      return { stdout: "", stderr: "" };
    });
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", branch: "symphony/mat-1", createBranch: true });

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--verify", "--quiet", "refs/heads/symphony/mat-1"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/symphony/mat-1"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(3, "git", ["worktree", "add", "-b", "symphony/mat-1", "--track", "--", expect.any(String), "origin/symphony/mat-1"], expect.any(Object));
  });

  it("does not create fallback branches for remote projects when the branch is missing", async () => {
    await atomicWriteJson(join(homePath, "projects", "repo", "config.json"), {
      id: "proj_repo",
      slug: "repo",
      name: "repo",
      remote: "https://github.com/owner/repo.git",
      localPath: join(homePath, "projects", "repo", "repo"),
      defaultBranch: "main",
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "local" },
      github: { owner: "owner", repo: "repo", htmlUrl: "https://github.com/owner/repo", authState: "ok" },
    });
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse") throw new Error("missing branch");
      if (args.includes("-b")) throw new Error("unexpected fallback branch creation");
      return { stdout: "", stderr: "" };
    });
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", branch: "typo/new-branch", createBranch: true });

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--verify", "--quiet", "refs/heads/typo/new-branch"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/typo/new-branch"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(3, "git", ["worktree", "add", "--", expect.any(String), "typo/new-branch"], expect.any(Object));
  });

  it("creates a new branch worktree immediately from a scratch project", async () => {
    const projectManager = createProjectManager({ homePath, now: () => "2026-04-26T00:00:00.000Z" });
    const createdProject = await projectManager.createProject({
      mode: "scratch",
      name: "Scratch Flow",
      slug: "scratch-flow",
    });
    expect(createdProject.ok).toBe(true);

    const worktreeManager = createWorktreeManager({ homePath, now: () => "2026-04-26T00:00:00.000Z" });
    const createdWorktree = await worktreeManager.createWorktree({
      projectSlug: "scratch-flow",
      branch: "feature/first",
      createBranch: true,
    });

    expect(createdWorktree.ok).toBe(true);
    if (!createdWorktree.ok) return;
    expect(createdWorktree.worktree.currentBranch).toBe("feature/first");
    await expect(stat(createdWorktree.worktree.path)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(join(createdWorktree.worktree.path, ".matrix", "worktree.json"), "utf-8")).resolves.toContain("feature/first");
  });

  it("serializes concurrent creation for the same worktree", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = createWorktreeManager({ homePath, runCommand });

    const results = await Promise.all([
      manager.createWorktree({ projectSlug: "repo", branch: "feature/concurrent" }),
      manager.createWorktree({ projectSlug: "repo", branch: "feature/concurrent" }),
    ]);

    expect(results.filter((result) => result.ok && result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.status === 200)).toHaveLength(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "add", "--", expect.any(String), "feature/concurrent"], expect.any(Object));
  });

  it("rejects invalid refs before invoking git", async () => {
    const runCommand = vi.fn();
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", branch: "feature;rm -rf /" });

    expect(result).toMatchObject({ ok: false, status: 400, error: { code: "invalid_ref" } });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("enforces write leases and allows the holder to release them", async () => {
    const manager = createWorktreeManager({ homePath, runCommand: vi.fn(async () => ({ stdout: "", stderr: "" })) });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "main" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(manager.acquireLease({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: "sess_1",
    })).resolves.toMatchObject({ ok: true });
    await expect(manager.acquireLease({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: "sess_2",
    })).resolves.toMatchObject({ ok: false, status: 409, holderId: "sess_1" });

    await expect(manager.releaseLease({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderId: "sess_1",
    })).resolves.toMatchObject({ ok: true });
  });

  it("allows only one concurrent writer to acquire a new worktree lease", async () => {
    const manager = createWorktreeManager({ homePath, runCommand: vi.fn(async () => ({ stdout: "", stderr: "" })) });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "race" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => manager.acquireLease({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: `sess_${index}`,
    })));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.status === 409)).toHaveLength(19);
  });

  it("requires explicit confirmation before deleting dirty worktrees", async () => {
    const runCommand = vi.fn(async () => ({ stdout: " M file.ts\n", stderr: "" }));
    const manager = createWorktreeManager({ homePath, runCommand });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "dirty" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await writeFile(join(created.worktree.path, "file.ts"), "changed");

    await expect(manager.deleteWorktree({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      confirmDirtyDelete: false,
    })).resolves.toMatchObject({ ok: false, status: 409, error: { code: "dirty_worktree_confirmation_required" } });

    await expect(manager.deleteWorktree({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      confirmDirtyDelete: true,
    })).resolves.toMatchObject({ ok: true });
    expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", "--force", "--", created.worktree.path], expect.any(Object));
    await expect(stat(created.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when dirty-state inspection fails without confirmation", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") throw new Error("git status timed out");
      return { stdout: "", stderr: "" };
    });
    const manager = createWorktreeManager({ homePath, runCommand });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "unknown-dirty" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await writeFile(join(created.worktree.path, "file.ts"), "changed");

    await expect(manager.deleteWorktree({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      confirmDirtyDelete: false,
    })).resolves.toMatchObject({ ok: false, status: 409, error: { code: "dirty_state_unknown" } });
    await expect(stat(created.worktree.path)).resolves.toMatchObject({ isDirectory: expect.any(Function) });

    await expect(manager.deleteWorktree({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      confirmDirtyDelete: true,
    })).resolves.toMatchObject({ ok: true });
  });
});
