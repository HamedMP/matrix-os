import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { lstat, mkdir, mkdtemp, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSandbox } from "../../packages/gateway/src/agent-sandbox.js";

describe("agent-sandbox", () => {
  let homePath: string;
  let worktreePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-agent-sandbox-"));
    worktreePath = join(homePath, "projects", "repo", "worktrees", "wt_abc123def456");
    await mkdir(worktreePath, { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("creates fail-closed Codex sandbox metadata scoped to the worktree and scratch dir", async () => {
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000 });

    const result = await sandbox.preflight({
      agent: "codex",
      sessionId: "sess_abc123",
      worktreePath,
    });

    expect(result).toMatchObject({
      ok: true,
      sandbox: {
        enabled: true,
        writableRoots: [
          await realpath(worktreePath),
          join(homePath, "system", "agent-scratch", "sess_abc123"),
        ],
      },
    });
    await expect(stat(join(homePath, "system", "agent-scratch", "sess_abc123"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("verifies a strict Claude sandbox before returning scoped launch metadata", async () => {
    const verifyClaudeSandbox = vi.fn(async () => undefined);
    const sandbox = createAgentSandbox({
      homePath,
      getUid: () => 1000,
      verifyClaudeSandbox,
    });

    const result = await sandbox.preflight({
      agent: "claude",
      sessionId: "sess_abc123",
      worktreePath,
      approvalPolicy: "on-request",
      sandboxMode: "workspace_write",
    });

    expect(result).toMatchObject({
      ok: true,
      sandbox: {
        enabled: true,
        mode: "workspace-write",
        writableRoots: [
          await realpath(worktreePath),
          join(homePath, "system", "agent-scratch", "sess_abc123"),
        ],
      },
      status: {
        available: true,
        enforced: true,
        requiresAdminOverride: false,
        reason: "ok",
      },
    });
    expect(verifyClaudeSandbox).toHaveBeenCalledWith(expect.objectContaining({
      cwd: await realpath(worktreePath),
      runtimeHome: homePath,
      approvalPolicy: "on-request",
      sandbox: expect.objectContaining({ mode: "workspace-write" }),
    }));
  });

  it("removes failed Claude scratch state and returns only a safe preflight error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sandbox = createAgentSandbox({
      homePath,
      getUid: () => 1000,
      verifyClaudeSandbox: vi.fn(async () => {
        throw new Error(`sandbox dependency missing at ${homePath}`);
      }),
    });

    await expect(sandbox.preflight({
      agent: "claude",
      sessionId: "sess_abc123",
      worktreePath,
      approvalPolicy: "on-request",
      sandboxMode: "workspace_write",
    })).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: { code: "sandbox_unavailable", message: "Agent sandbox is unavailable" },
    });
    await expect(stat(join(homePath, "system", "agent-scratch", "sess_abc123"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(JSON.stringify(await sandbox.preflight({
      agent: "claude",
      sessionId: "sess_second",
      worktreePath,
      approvalPolicy: "on-request",
      sandboxMode: "workspace_write",
    }))).not.toContain(homePath);
    expect(warn).toHaveBeenCalled();
  });

  it("does not follow a scratch symlink swapped in during failed Claude verification", async () => {
    const outside = await mkdtemp(join(tmpdir(), "matrix-agent-verifier-outside-"));
    const scratchPath = join(homePath, "system", "agent-scratch", "sess_swapped");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sandbox = createAgentSandbox({
      homePath,
      getUid: () => 1000,
      verifyClaudeSandbox: vi.fn(async () => {
        rmSync(scratchPath, { recursive: true, force: true });
        await symlink(outside, scratchPath, "dir");
        throw new Error("sandbox verifier failed");
      }),
    });

    try {
      await expect(sandbox.preflight({
        agent: "claude",
        sessionId: "sess_swapped",
        worktreePath,
        approvalPolicy: "on-request",
        sandboxMode: "workspace_write",
      })).resolves.toMatchObject({
        ok: false,
        status: 503,
        error: { code: "sandbox_unavailable", message: "Agent sandbox is unavailable" },
      });
      await expect(stat(outside)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      expect((await lstat(scratchPath)).isSymbolicLink()).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not let a duplicate preflight remove an accepted session scratch root", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warn.mockClear();
    const verifyClaudeSandbox = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("later verifier failure"));
    const sandbox = createAgentSandbox({
      homePath,
      getUid: () => 1000,
      verifyClaudeSandbox,
    });
    const request = {
      agent: "claude",
      sessionId: "sess_shared",
      worktreePath,
      approvalPolicy: "on-request",
      sandboxMode: "workspace_write",
    } as const;

    await expect(sandbox.preflight(request)).resolves.toMatchObject({ ok: true });
    await expect(sandbox.preflight(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "sandbox_unavailable" },
    });

    expect(verifyClaudeSandbox).toHaveBeenCalledTimes(1);
    await expect(stat(join(homePath, "system", "agent-scratch", "sess_shared"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a scratch root redirected outside the canonical owner home", async () => {
    const outside = await mkdtemp(join(tmpdir(), "matrix-agent-scratch-outside-"));
    await symlink(outside, join(homePath, "system"), "dir");
    const verifyClaudeSandbox = vi.fn(async () => undefined);
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000, verifyClaudeSandbox });

    try {
      await expect(sandbox.preflight({
        agent: "claude",
        sessionId: "sess_redirected",
        worktreePath,
        approvalPolicy: "on-request",
        sandboxMode: "workspace_write",
      })).resolves.toMatchObject({
        ok: false,
        error: { code: "sandbox_unavailable" },
      });
      expect(verifyClaudeSandbox).not.toHaveBeenCalled();
      await expect(stat(join(outside, "sess_redirected"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a worktree symlink whose canonical target escapes the owner home", async () => {
    const outside = await mkdtemp(join(tmpdir(), "matrix-agent-worktree-outside-"));
    const redirected = join(homePath, "projects", "repo", "worktrees", "wt_redirected123");
    await symlink(outside, redirected, "dir");
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000 });

    try {
      await expect(sandbox.preflight({
        agent: "codex",
        sessionId: "sess_redirected_worktree",
        worktreePath: redirected,
      })).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: { code: "invalid_worktree_path", message: "Worktree path is invalid" },
      });
      await expect(stat(outside)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reclaims an old scratch directory only when no active session owns it", async () => {
    const scratchPath = join(homePath, "system", "agent-scratch", "sess_stale");
    await mkdir(scratchPath, { recursive: true });
    const old = new Date(Date.now() - 31 * 60_000);
    await utimes(scratchPath, old, old);
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000 });

    await expect(sandbox.preflight({
      agent: "codex",
      sessionId: "sess_stale",
      worktreePath,
    })).resolves.toMatchObject({
      ok: true,
      sandbox: { writableRoots: [await realpath(worktreePath), scratchPath] },
    });
    await expect(stat(scratchPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });

    const activeScratch = join(homePath, "system", "agent-scratch", "sess_active");
    await mkdir(activeScratch, { recursive: true });
    await utimes(activeScratch, old, old);
    await mkdir(join(homePath, "system", "sessions"), { recursive: true });
    await writeFile(join(homePath, "system", "sessions", "sess_active.json"), JSON.stringify({
      id: "sess_active",
      runtime: { status: "running" },
    }));

    await expect(sandbox.preflight({
      agent: "codex",
      sessionId: "sess_active",
      worktreePath,
    })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "sandbox_unavailable" },
    });
    await expect(stat(activeScratch)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("cleans only a validated non-symlink session scratch directory", async () => {
    const scratchPath = join(homePath, "system", "agent-scratch", "sess_cleanup");
    await mkdir(scratchPath, { recursive: true });
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000 });

    await sandbox.cleanup({ sessionId: "sess_cleanup" });

    await expect(stat(scratchPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sandbox.cleanup({ sessionId: "../outside" })).resolves.toBeUndefined();
  });

  it("skips symlink scratch entries during cleanup", async () => {
    const outside = await mkdtemp(join(tmpdir(), "matrix-agent-cleanup-outside-"));
    const scratchRoot = join(homePath, "system", "agent-scratch");
    await mkdir(scratchRoot, { recursive: true });
    await symlink(outside, join(scratchRoot, "sess_link"), "dir");
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000 });

    try {
      await sandbox.cleanup({ sessionId: "sess_link" });
      await expect(stat(outside)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("preflights the effective Claude mode when review overrides full access", async () => {
    const verifyClaudeSandbox = vi.fn(async () => undefined);
    const gitCommonDir = join(homePath, "projects", "repo", "repo", ".git");
    await mkdir(gitCommonDir, { recursive: true });
    const resolveGitCommonDir = vi.fn(async () => gitCommonDir);
    const sandbox = createAgentSandbox({
      homePath,
      getUid: () => 1000,
      verifyClaudeSandbox,
      resolveGitCommonDir,
    });

    await expect(sandbox.preflight({
      agent: "claude",
      sessionId: "sess_review",
      worktreePath,
      mode: "review",
      approvalPolicy: "on-request",
      sandboxMode: "full_access",
    })).resolves.toMatchObject({ ok: true });
    expect(verifyClaudeSandbox).toHaveBeenCalledWith(expect.objectContaining({
      mode: "review",
      sandbox: expect.objectContaining({
        mode: "read-only",
        writableRoots: [],
        denyWriteRoots: [await realpath(worktreePath), await realpath(gitCommonDir)],
      }),
    }));
    expect(resolveGitCommonDir).toHaveBeenCalledWith(await realpath(worktreePath));
  });

  it("lets Claude review non-Git folder projects start with a workspace-only deny root", async () => {
    const verifyClaudeSandbox = vi.fn(async () => undefined);
    // A null resolution means the workspace is not inside a Git repository:
    // there is no Git metadata to protect, so review stays read-only over the
    // workspace root alone instead of failing sandbox_unavailable.
    const resolveGitCommonDir = vi.fn(async () => null);
    const sandbox = createAgentSandbox({
      homePath,
      getUid: () => 1000,
      verifyClaudeSandbox,
      resolveGitCommonDir,
    });

    await expect(sandbox.preflight({
      agent: "claude",
      sessionId: "sess_review_plain",
      worktreePath,
      mode: "review",
      approvalPolicy: "on-request",
      sandboxMode: "full_access",
    })).resolves.toMatchObject({ ok: true });
    expect(verifyClaudeSandbox).toHaveBeenCalledWith(expect.objectContaining({
      mode: "review",
      sandbox: expect.objectContaining({
        mode: "read-only",
        // The sandbox canonicalizes paths (macOS tmpdir is a /var symlink).
        denyWriteRoots: [await realpath(worktreePath)],
      }),
    }));
  });

  it("fails closed when running as root unless an explicit admin override is configured", async () => {
    const sandbox = createAgentSandbox({ homePath, getUid: () => 0 });

    await expect(sandbox.preflight({
      agent: "codex",
      sessionId: "sess_abc123",
      worktreePath,
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: { code: "sandbox_unavailable" },
      sandboxStatus: {
        available: false,
        requiresAdminOverride: true,
        reason: "root_user",
      },
    });

    await expect(sandbox.preflight({
      agent: "codex",
      sessionId: "sess_abc123",
      worktreePath,
      adminOverride: true,
    })).resolves.toMatchObject({
      ok: true,
      sandbox: { enabled: false, adminOverride: true },
      status: {
        available: false,
        enforced: false,
        requiresAdminOverride: true,
        reason: "admin_override",
      },
    });
  });

  it("does not allow a root override for Claude execution", async () => {
    const verifyClaudeSandbox = vi.fn(async () => undefined);
    const sandbox = createAgentSandbox({
      homePath,
      getUid: () => 0,
      verifyClaudeSandbox,
    });

    await expect(sandbox.preflight({
      agent: "claude",
      sessionId: "sess_abc123",
      worktreePath,
      adminOverride: true,
      approvalPolicy: "never",
      sandboxMode: "full_access",
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: { code: "sandbox_unavailable", message: "Agent sandbox is unavailable" },
    });
    expect(verifyClaudeSandbox).not.toHaveBeenCalled();
  });

  it("rejects missing or out-of-home worktrees before creating scratch dirs", async () => {
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000 });

    await expect(sandbox.preflight({
      agent: "codex",
      sessionId: "sess_abc123",
      worktreePath: join(homePath, "projects", "repo", "worktrees", "missing"),
    })).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "not_found" },
    });

    await expect(sandbox.preflight({
      agent: "codex",
      sessionId: "sess_abc123",
      worktreePath: "/tmp/outside-worktree",
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_worktree_path" },
    });

    await expect(stat(join(homePath, "system", "agent-scratch", "sess_abc123"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports sanitized sandbox status without filesystem details", async () => {
    const sandbox = createAgentSandbox({ homePath, getUid: () => 0 });

    const status = await sandbox.status();

    expect(status).toEqual({
      available: false,
      enforced: false,
      requiresAdminOverride: true,
      reason: "root_user",
    });
    expect(JSON.stringify(status)).not.toContain(homePath);
  });
});
