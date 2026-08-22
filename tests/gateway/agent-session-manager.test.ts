import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
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
    terminalRuntime?: Partial<ReturnType<typeof baseTerminalRuntime>>;
  } = {}) {
    const worktreeManager = createWorktreeManager({
      homePath,
      runCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
      now,
    });
    const terminalRuntime = { ...baseTerminalRuntime(), ...overrides.terminalRuntime };
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
        terminalRuntime,
        now,
        idGenerator: () => "sess_abc123",
      }),
      worktreeManager,
      terminalRuntime,
      agentLauncher,
    };
  }

  function baseTerminalRuntime() {
    return {
      ensureWorkspace: vi.fn(async () => ({ id: "tws_00000000000000000000000000000001" })),
      createTab: vi.fn(async () => ({ id: "tt_00000000000000000000000000000001" })),
      terminateTab: vi.fn(async () => undefined),
      writeInput: vi.fn(async () => undefined),
      listWorkspaces: vi.fn(async () => [{
        id: "tws_00000000000000000000000000000001",
        tabs: [{ id: "tt_00000000000000000000000000000001", status: "running" }],
      }]),
    };
  }

  it("deletes only inactive project sessions owned by the requesting user", async () => {
    const { manager } = createManager();
    const baseSession = {
      id: "sess_inactive",
      kind: "agent" as const,
      projectSlug: "repo",
      runtime: { type: "zellij" as const, status: "exited" as const },
      terminalRef: {
        workspaceId: "tws_00000000000000000000000000000001",
        tabId: "tt_00000000000000000000000000000001",
      },
      transcriptPath: join(homePath, "system", "session-output", "sess_inactive.jsonl"),
      attachedClients: 0,
      writeMode: "closed" as const,
      ownerId: "user_a",
      startedAt: "2026-04-26T00:00:00.000Z",
      lastActivityAt: "2026-04-26T00:00:00.000Z",
    };
    await atomicWriteJson(join(homePath, "system", "sessions", "sess_inactive.json"), baseSession);
    await atomicWriteJson(join(homePath, "system", "sessions", "sess_other_owner.json"), {
      ...baseSession,
      id: "sess_other_owner",
      ownerId: "user_b",
    });
    await atomicWriteJson(join(homePath, "system", "sessions", "sess_active.json"), {
      ...baseSession,
      id: "sess_active",
      runtime: { type: "zellij", status: "running" },
      writeMode: "owner",
    });

    await expect(manager.getProjectLifecycleState({ projectSlug: "repo", ownerId: "user_a" }))
      .resolves.toEqual({ activeSessionCount: 1, sessionCount: 2 });

    await expect(manager.deleteProjectSessions({ projectSlug: "repo", ownerId: "user_a" }))
      .resolves.toMatchObject({ ok: false, status: 409, error: { code: "project_active" } });
    await atomicWriteJson(join(homePath, "system", "sessions", "sess_active.json"), {
      ...baseSession,
      id: "sess_active",
    });
    await expect(manager.deleteProjectSessions({ projectSlug: "repo", ownerId: "user_a" }))
      .resolves.toEqual({ ok: true, deleted: 2 });

    await expect(stat(join(homePath, "system", "sessions", "sess_inactive.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(homePath, "system", "sessions", "sess_other_owner.json"))).resolves.toBeTruthy();
  });

  it("starts an agent session by acquiring the worktree lease and persisting runtime metadata", async () => {
    const { manager, terminalRuntime, agentLauncher } = createManager();

    const result = await manager.startSession({
      kind: "agent",
      agent: "codex",
      ownerId: "user_a",
      projectSlug: "repo",
      taskId: "task_123",
      worktreeId,
      pr: 42,
      prompt: "fix tests; rm -rf /",
      mode: "review",
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
        terminalRef: {
          workspaceId: "tws_00000000000000000000000000000001",
          tabId: "tt_00000000000000000000000000000001",
        },
        runtime: {
          type: "zellij",
          status: "running",
        },
      },
    });
    expect(agentLauncher.buildLaunch).toHaveBeenCalledWith(expect.objectContaining({
      agent: "codex",
      prompt: "fix tests; rm -rf /",
      mode: "review",
      cwd: join(homePath, "projects", "repo", "worktrees", worktreeId),
    }));
    expect(terminalRuntime.ensureWorkspace).toHaveBeenCalledWith({ projectId: "proj_repo" });
    expect(terminalRuntime.createTab).toHaveBeenCalledWith(
      "tws_00000000000000000000000000000001",
      expect.objectContaining({
        name: "codex",
        command: expect.arrayContaining(["codex"]),
        agent: { providerId: "codex" },
      }),
    );

    const record = JSON.parse(await readFile(join(homePath, "system", "sessions", "sess_abc123.json"), "utf-8"));
    expect(record.transcriptPath).toBe(join(homePath, "system", "session-output", "sess_abc123.jsonl"));
    expect(record.writeMode).toBe("owner");
    expect(record.ownerId).toBe("user_a");
  });

  it("includes bounded structured attachments in the agent launch prompt", async () => {
    const { manager, agentLauncher } = createManager();

    await manager.startSession({
      kind: "agent",
      agent: "codex",
      ownerId: "user_a",
      projectSlug: "repo",
      worktreeId,
      prompt: "Please follow up on this review hunk.",
      attachments: [
        {
          id: "review:rev_desktop_1:hunk:hunk_1",
          kind: "structured_ref",
          label: "Review hunk 1",
          path: "packages/gateway/src/coding-agents/routes.ts",
        },
      ],
    });

    expect(agentLauncher.buildLaunch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Please follow up on this review hunk."),
    }));
    expect(agentLauncher.buildLaunch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("[structured_ref] Review hunk 1: packages/gateway/src/coding-agents/routes.ts"),
    }));
    expect(agentLauncher.buildLaunch).not.toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(/export const|function create|raw diff/i),
    }));
  });

  it("keeps structured references when the launch prompt is near the prompt bound", async () => {
    const { manager, agentLauncher } = createManager();
    const maxPrompt = "x".repeat(100_000);

    await manager.startSession({
      kind: "agent",
      agent: "codex",
      ownerId: "user_a",
      projectSlug: "repo",
      worktreeId,
      prompt: maxPrompt,
      attachments: [
        {
          id: "review:rev_desktop_1:hunk:hunk_2",
          kind: "structured_ref",
          label: "Review hunk 2",
          path: "packages/gateway/src/agent-session-manager.ts",
        },
      ],
    });

    expect(agentLauncher.buildLaunch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("[structured_ref] Review hunk 2: packages/gateway/src/agent-session-manager.ts"),
    }));
    const launchPrompt = vi.mocked(agentLauncher.buildLaunch).mock.calls.at(-1)?.[0].prompt;
    expect(launchPrompt).toBeDefined();
    expect(launchPrompt?.length).toBeLessThanOrEqual(100_000);
  });

  it("rejects competing write sessions before launching a runtime", async () => {
    const { manager, worktreeManager, terminalRuntime } = createManager();
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
    expect(terminalRuntime.createTab).not.toHaveBeenCalled();
  });

  it("sends input, kills the runtime, and releases the worktree lease", async () => {
    now
      .mockReturnValueOnce("2026-04-26T00:00:00.000Z")
      .mockReturnValueOnce("2026-04-26T00:00:10.000Z")
      .mockReturnValueOnce("2026-04-26T00:00:20.000Z");
    const { manager, terminalRuntime, worktreeManager } = createManager();
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
    expect(terminalRuntime.writeInput).toHaveBeenCalledWith({
      workspaceId: "tws_00000000000000000000000000000001",
      tabId: "tt_00000000000000000000000000000001",
    }, "pnpm test\n");

    await expect(manager.killSession("sess_abc123")).resolves.toMatchObject({
      ok: true,
      session: { runtime: { status: "exited" }, writeMode: "closed" },
    });
    expect(terminalRuntime.terminateTab).toHaveBeenCalledWith({
      workspaceId: "tws_00000000000000000000000000000001",
      tabId: "tt_00000000000000000000000000000001",
    });
    await expect(worktreeManager.acquireLease({
      projectSlug: "repo",
      worktreeId,
      holderType: "session",
      holderId: "sess_after",
    })).resolves.toMatchObject({ ok: true });
  });

  it("releases the worktree lease and closes session state when runtime kill fails", async () => {
    const { manager, terminalRuntime, worktreeManager } = createManager({
      terminalRuntime: {
        terminateTab: vi.fn(async () => {
          throw new Error("zellij unavailable");
        }),
      },
    });
    const started = await manager.startSession({
      kind: "agent",
      agent: "claude",
      ownerId: "user_a",
      projectSlug: "repo",
      worktreeId,
      prompt: "work",
    });
    expect(started.ok).toBe(true);

    await expect(manager.killSession("sess_abc123")).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: { code: "runtime_unavailable" },
    });
    expect(terminalRuntime.terminateTab).toHaveBeenCalled();
    await expect(manager.getSession("sess_abc123")).resolves.toMatchObject({
      ok: true,
      session: { runtime: { status: "degraded", fallbackReason: "kill_failed" }, writeMode: "closed" },
    });
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
      terminalRuntime: {
        listWorkspaces: vi.fn(async () => { throw new Error("runtime unavailable"); }),
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
      releasedLeases: 1,
      stoppedSessions: [
        expect.objectContaining({
          id: "sess_abc123",
          kind: "agent",
          ownerId: "user_a",
          runtime: expect.objectContaining({
            status: "degraded",
            fallbackReason: "runtime_degraded",
          }),
          terminalRef: {
            workspaceId: "tws_00000000000000000000000000000001",
            tabId: "tt_00000000000000000000000000000001",
          },
          writeMode: "closed",
        }),
      ],
    });
    await expect(manager.getSession("sess_abc123")).resolves.toMatchObject({
      ok: true,
      session: {
        runtime: {
          status: "degraded",
          fallbackReason: "runtime_degraded",
        },
        writeMode: "closed",
      },
    });
  });

  it("marks only a session whose runtime tab is no longer alive as degraded", async () => {
    const { manager } = createManager({
      terminalRuntime: { listWorkspaces: vi.fn(async () => []) },
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

    expect(result).toMatchObject({ degraded: 1, releasedLeases: 1 });
    await expect(manager.getSession("sess_abc123")).resolves.toMatchObject({
      ok: true,
      session: { runtime: { status: "degraded", fallbackReason: "runtime_degraded" } },
    });
  });
});
