import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";

describe("worktree-manager", () => {
  let homePath: string;

  async function materializeAddedWorktree(args: string[]): Promise<void> {
    if (args[0] !== "worktree" || args[1] !== "add") return;
    const separator = args.indexOf("--");
    const path = separator >= 0 ? args[separator + 1] : undefined;
    if (path) await mkdir(path, { recursive: true });
  }

  function successfulRunCommand(stdout = "") {
    return vi.fn(async (_command: string, args: string[]) => {
      await materializeAddedWorktree(args);
      return { stdout, stderr: "" };
    });
  }

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
      await materializeAddedWorktree(args);
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
    const metadata = JSON.parse(await readFile(
      join(homePath, "system", "projects", "repo", "worktrees", first.worktree.id, "worktree.json"),
      "utf-8",
    ));
    expect(metadata.pr.number).toBe(42);
    expect(first.worktree.path).toBe(join(homePath, "worktrees", "repo", first.worktree.id));
    await expect(stat(join(homePath, "projects", "repo", "worktrees")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves an exact worktree only inside the owning project scope", async () => {
    const manager = createWorktreeManager({ homePath, runCommand: successfulRunCommand() });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "feature/root" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(manager.getWorktree(
      "repo",
      created.worktree.id,
      { type: "user", id: "local" },
    )).resolves.toMatchObject({ ok: true, worktree: { id: created.worktree.id } });
    await expect(manager.getWorktree(
      "repo",
      created.worktree.id,
      { type: "user", id: "another-owner" },
    )).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("fetches GitHub PR refs before creating a PR worktree", async () => {
    const runCommand = successfulRunCommand();
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", pr: 42 });

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["fetch", "origin", "pull/42/head:refs/heads/pr-42"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(2, "git", ["worktree", "add", "--", expect.any(String), "pr-42"], expect.any(Object));
  });

  it("creates a missing branch worktree from the project base ref when requested", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse") throw new Error("missing branch");
      await materializeAddedWorktree(args);
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
      await materializeAddedWorktree(args);
      return { stdout: "", stderr: "" };
    });
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", branch: "symphony/mat-1", createBranch: true });

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--verify", "--quiet", "refs/heads/symphony/mat-1"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/symphony/mat-1"], expect.any(Object));
    expect(runCommand).toHaveBeenNthCalledWith(3, "git", ["worktree", "add", "-b", "symphony/mat-1", "--track", "--", expect.any(String), "origin/symphony/mat-1"], expect.any(Object));
  });

  it("lists only live project worktree leases as lifecycle blockers", async () => {
    const now = () => "2026-04-26T00:00:00.000Z";
    const manager = createWorktreeManager({
      homePath,
      runCommand: successfulRunCommand(),
      now,
    });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "feature/lifecycle" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(manager.listActiveLeases("repo")).resolves.toEqual({ ok: true, leases: [] });
    await manager.acquireLease({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: "sess_lifecycle",
    });
    await expect(manager.listActiveLeases("repo")).resolves.toMatchObject({
      ok: true,
      leases: [{ worktreeId: created.worktree.id, holderId: "sess_lifecycle" }],
    });
  });

  it("reads one canonical worktree without scanning sibling records", async () => {
    const manager = createWorktreeManager({ homePath, runCommand: successfulRunCommand() });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "feature/one" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(manager.getWorktree("repo", created.worktree.id)).resolves.toEqual({
      ok: true,
      worktree: created.worktree,
    });
  });

  it("rejects malformed canonical worktree metadata", async () => {
    const manager = createWorktreeManager({ homePath, runCommand: successfulRunCommand() });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "main" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const metadataPath = join(
      homePath,
      "system",
      "projects",
      "repo",
      "worktrees",
      created.worktree.id,
      "worktree.json",
    );
    await atomicWriteJson(metadataPath, {
      id: created.worktree.id,
      projectSlug: "repo",
      path: created.worktree.path,
      sourceBranch: "main",
      currentBranch: "main",
      dirtyState: "not-a-real-state",
      createdAt: "2026-04-26T00:00:00.000Z",
    });

    await expect(manager.getWorktree("repo", created.worktree.id)).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "not_found" },
    });
  });

  it("serializes concurrent creation for the same worktree", async () => {
    const runCommand = successfulRunCommand();
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

  it("preserves a pre-existing worktree directory when metadata is missing", async () => {
    const branch = "feature/recovery";
    const id = `wt_${createHash("sha256").update(`repo:${branch}`).digest("hex").slice(0, 16)}`;
    const existingPath = join(homePath, "worktrees", "repo", id);
    await mkdir(existingPath, { recursive: true });
    await writeFile(join(existingPath, "UNCOMMITTED.txt"), "owner changes");
    const runCommand = vi.fn(async () => {
      throw new Error("destination already exists");
    });
    const manager = createWorktreeManager({ homePath, runCommand });

    await expect(manager.createWorktree({ projectSlug: "repo", branch })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "worktree_path_conflict" },
    });
    await expect(readFile(join(existingPath, "UNCOMMITTED.txt"), "utf-8")).resolves.toBe("owner changes");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects invalid refs before invoking git", async () => {
    const runCommand = vi.fn();
    const manager = createWorktreeManager({ homePath, runCommand });

    const result = await manager.createWorktree({ projectSlug: "repo", branch: "feature;rm -rf /" });

    expect(result).toMatchObject({ ok: false, status: 400, error: { code: "invalid_ref" } });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects worktree creation from a different owner scope", async () => {
    const runCommand = successfulRunCommand();
    const manager = createWorktreeManager({ homePath, runCommand });

    await expect(manager.createWorktree({
      projectSlug: "repo",
      branch: "main",
      ownerScope: { type: "user", id: "user_b" },
    })).resolves.toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("enforces write leases and allows the holder to release them", async () => {
    const manager = createWorktreeManager({ homePath, runCommand: successfulRunCommand() });
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

  it("ignores malformed lease metadata so it cannot block a worktree forever", async () => {
    const manager = createWorktreeManager({
      homePath,
      runCommand: successfulRunCommand(),
      now: () => "2026-04-26T01:00:00.000Z",
    });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "lease-validation" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const leasePath = join(
      homePath,
      "system",
      "projects",
      "repo",
      "worktrees",
      created.worktree.id,
      "lease.json",
    );
    await atomicWriteJson(leasePath, {
      id: "lease_00000000-0000-4000-8000-000000000000",
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: "sess_stuck",
      mode: "write",
      acquiredAt: "2026-04-26T00:00:00.000Z",
      heartbeatAt: "not-a-timestamp",
    });

    await expect(manager.listActiveLeases("repo")).resolves.toEqual({ ok: true, leases: [] });
    await expect(stat(leasePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(manager.acquireLease({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: "sess_recovered",
    })).resolves.toMatchObject({ ok: true, lease: { holderId: "sess_recovered" } });
    await expect(manager.listActiveLeases("repo")).resolves.toMatchObject({
      ok: true,
      leases: [{ holderId: "sess_recovered" }],
    });
  });

  it("discards oversized lease metadata without parsing it during recovery", async () => {
    const manager = createWorktreeManager({
      homePath,
      runCommand: successfulRunCommand(),
      now: () => "2026-04-26T01:00:00.000Z",
    });
    const created = await manager.createWorktree({ projectSlug: "repo", branch: "oversized-lease" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const leasePath = join(
      homePath,
      "system",
      "projects",
      "repo",
      "worktrees",
      created.worktree.id,
      "lease.json",
    );
    await writeFile(leasePath, JSON.stringify({
      id: "lease_00000000-0000-4000-8000-000000000000",
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: "sess_oversized",
      mode: "write",
      acquiredAt: "2026-04-26T00:00:00.000Z",
      heartbeatAt: "2026-04-26T01:00:00.000Z",
      padding: "x".repeat(300 * 1024),
    }));

    await expect(manager.acquireLease({
      projectSlug: "repo",
      worktreeId: created.worktree.id,
      holderType: "session",
      holderId: "sess_recovered",
    })).resolves.toMatchObject({ ok: true, lease: { holderId: "sess_recovered" } });
  });

  it("allows only one concurrent writer to acquire a new worktree lease", async () => {
    const manager = createWorktreeManager({ homePath, runCommand: successfulRunCommand() });
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
    const runCommand = successfulRunCommand(" M file.ts\n");
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
      await materializeAddedWorktree(args);
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
