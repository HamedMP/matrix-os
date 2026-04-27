import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
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
          worktreePath,
          join(homePath, "system", "agent-scratch", "sess_abc123"),
        ],
      },
    });
    await expect(stat(join(homePath, "system", "agent-scratch", "sess_abc123"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("returns no sandbox metadata for agents that do not require Codex-style sandboxing", async () => {
    const sandbox = createAgentSandbox({ homePath, getUid: () => 1000 });

    await expect(sandbox.preflight({
      agent: "claude",
      sessionId: "sess_abc123",
      worktreePath,
    })).resolves.toEqual({
      ok: true,
      sandbox: undefined,
      status: {
        available: true,
        enforced: false,
        requiresAdminOverride: false,
        reason: "not_required",
      },
    });
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
