import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";
import type { AgentLaunchInput, AgentLaunchSpec } from "../../packages/gateway/src/agent-launcher.js";

describe("agent-session-manager", () => {
  let homePath: string;
  const now = vi.fn();
  const worktreeId = "wt_abc123def456";

  beforeEach(async () => {
    now.mockReturnValue("2026-04-26T00:00:00.000Z");
    homePath = await mkdtemp(join(tmpdir(), "matrix-agent-session-manager-"));
    const repoPath = join(homePath, "projects", "repo", "repo");
    const worktreePath = join(homePath, "projects", "repo", "worktrees", worktreeId);
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await mkdir(join(worktreePath, ".matrix"), { recursive: true });
    await atomicWriteJson(join(homePath, "projects", "repo", "config.json"), {
      id: "proj_repo",
      slug: "repo",
      name: "repo",
      localPath: repoPath,
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    });
    await atomicWriteJson(join(worktreePath, ".matrix", "worktree.json"), {
      id: worktreeId,
      projectSlug: "repo",
      path: worktreePath,
      sourceBranch: "main",
      currentBranch: "main",
      dirtyState: "unknown",
      createdAt: "2026-04-26T00:00:00.000Z",
    });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createManager(overrides: {
    zellijRuntime?: Partial<ReturnType<typeof baseZellijRuntime>>;
    inputWriter?: (sessionId: string, input: string) => Promise<void>;
  } = {}) {
    const worktreeManager = createWorktreeManager({
      homePath,
      runCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
      now,
    });
    const zellijRuntime = { ...baseZellijRuntime(), ...overrides.zellijRuntime };
    const agentLauncher = {
      buildLaunch: vi.fn((input: AgentLaunchInput): AgentLaunchSpec => ({
        command: input.agent,
        args: ["--safe-mode", input.prompt ?? ""].filter((arg) => arg.length > 0),
        cwd: join(homePath, "projects", "repo", "worktrees", worktreeId),
        env: {},
      })),
    };
    return {
      manager: createAgentSessionManager({
        homePath,
        worktreeManager,
        agentLauncher,
        zellijRuntime,
        inputWriter: overrides.inputWriter,
        now,
        idGenerator: () => "sess_abc123",
      }),
      worktreeManager,
      zellijRuntime,
      agentLauncher,
    };
  }

  function baseZellijRuntime() {
    return {
      start: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        ok: true as const,
        status: "running" as const,
        sessionName: `matrix-${sessionId}`,
        layoutPath: join(homePath, "system", "zellij", "layouts", `${sessionId}.kdl`),
      })),
      attachCommand: vi.fn((sessionId: string) => ["zellij", "attach", `matrix-${sessionId}`]),
      observeCommand: vi.fn((sessionId: string) => ["zellij", "attach", `matrix-${sessionId}`, "--index", "0"]),
      kill: vi.fn(async () => ({ ok: true as const })),
      health: vi.fn(async () => ({
        available: true,
        status: "ok" as const,
        fallbackReason: null,
        version: "zellij 0.41.0",
      })),
    };
  }

  it("starts an agent session by acquiring the worktree lease and persisting runtime metadata", async () => {
    const { manager, zellijRuntime, agentLauncher } = createManager();

    const result = await manager.startSession({
      kind: "agent",
      agent: "codex",
      ownerId: "user_a",
      projectSlug: "repo",
      taskId: "task_123",
      worktreeId,
      pr: 42,
      prompt: "fix tests; rm -rf /",
      sandbox: { enabled: true },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      session: {
        id: "sess_abc123",
        kind: "agent",
        projectSlug: "repo",
        taskId: "task_123",
        worktreeId,
        pr: 42,
        agent: "codex",
        terminalSessionId: "term_sess_abc123",
        runtime: {
          type: "zellij",
          status: "running",
          zellijSession: "matrix-sess_abc123",
        },
        nativeAttachCommand: ["zellij", "attach", "matrix-sess_abc123"],
      },
    });
    expect(agentLauncher.buildLaunch).toHaveBeenCalledWith(expect.objectContaining({
      agent: "codex",
      prompt: "fix tests; rm -rf /",
      cwd: join(homePath, "projects", "repo", "worktrees", worktreeId),
    }));
    expect(zellijRuntime.start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_abc123",
      launch: expect.objectContaining({ command: "codex" }),
    }));

    const record = JSON.parse(await readFile(join(homePath, "system", "sessions", "sess_abc123.json"), "utf-8"));
    expect(record.transcriptPath).toBe(join(homePath, "system", "session-output", "sess_abc123.jsonl"));
    expect(record.writeMode).toBe("owner");
    expect(record.ownerId).toBe("user_a");
  });

  it("rejects competing write sessions before launching a runtime", async () => {
    const { manager, worktreeManager, zellijRuntime } = createManager();
    await worktreeManager.acquireLease({
      projectSlug: "repo",
      worktreeId,
      holderType: "session",
      holderId: "sess_other",
    });

    const result = await manager.startSession({
      kind: "agent",
      agent: "codex",
      ownerId: "user_a",
      projectSlug: "repo",
      worktreeId,
      prompt: "work",
      sandbox: { enabled: true },
    });

    expect(result).toMatchObject({ ok: false, status: 409, error: { code: "worktree_locked" } });
    expect(JSON.stringify(result)).toContain("sess_other");
    expect(zellijRuntime.start).not.toHaveBeenCalled();
  });

  it("sends input, kills the runtime, and releases the worktree lease", async () => {
    now
      .mockReturnValueOnce("2026-04-26T00:00:00.000Z")
      .mockReturnValueOnce("2026-04-26T00:00:10.000Z")
      .mockReturnValueOnce("2026-04-26T00:00:20.000Z");
    const inputWriter = vi.fn(async () => undefined);
    const { manager, zellijRuntime, worktreeManager } = createManager({ inputWriter });
    const started = await manager.startSession({
      kind: "agent",
      agent: "claude",
      ownerId: "user_a",
      projectSlug: "repo",
      worktreeId,
      prompt: "work",
    });
    expect(started.ok).toBe(true);

    await expect(manager.sendInput("sess_abc123", "pnpm test\n")).resolves.toMatchObject({ ok: true });
    expect(inputWriter).toHaveBeenCalledWith("sess_abc123", "pnpm test\n");

    await expect(manager.killSession("sess_abc123")).resolves.toMatchObject({
      ok: true,
      session: { runtime: { status: "exited" }, writeMode: "closed" },
    });
    expect(zellijRuntime.kill).toHaveBeenCalledWith("sess_abc123");
    await expect(worktreeManager.acquireLease({
      projectSlug: "repo",
      worktreeId,
      holderType: "session",
      holderId: "sess_after",
    })).resolves.toMatchObject({ ok: true });
  });

  it("lists and gets sessions with scoped filters", async () => {
    const { manager } = createManager();
    await manager.startSession({
      kind: "agent",
      agent: "pi",
      ownerId: "user_a",
      projectSlug: "repo",
      worktreeId,
      prompt: "work",
    });

    await expect(manager.getSession("sess_abc123")).resolves.toMatchObject({
      ok: true,
      session: { id: "sess_abc123" },
    });
    await expect(manager.listSessions({ projectSlug: "repo", limit: 10 })).resolves.toMatchObject({
      ok: true,
      sessions: [expect.objectContaining({ id: "sess_abc123" })],
      nextCursor: null,
    });
    await expect(manager.listSessions({ projectSlug: "other", limit: 10 })).resolves.toMatchObject({
      ok: true,
      sessions: [],
    });
  });

  it("marks active sessions degraded during startup reconciliation without exposing runtime errors", async () => {
    const { manager } = createManager({
      zellijRuntime: {
        health: vi.fn(async () => ({
          available: false,
          status: "degraded" as const,
          fallbackReason: "zellij_unavailable",
          version: null,
        })),
      },
    });
    await manager.startSession({
      kind: "agent",
      agent: "opencode",
      ownerId: "user_a",
      projectSlug: "repo",
      worktreeId,
      prompt: "work",
    });

    const result = await manager.reconcileStartup();

    expect(result).toEqual({
      checked: 1,
      degraded: 1,
      releasedLeases: 0,
    });
    await expect(manager.getSession("sess_abc123")).resolves.toMatchObject({
      ok: true,
      session: {
        runtime: {
          status: "degraded",
          fallbackReason: "zellij_unavailable",
        },
      },
    });
  });
});
