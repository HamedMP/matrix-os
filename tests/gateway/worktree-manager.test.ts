import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";
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
});
