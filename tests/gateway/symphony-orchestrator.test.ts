import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMatrixSymphonyOrchestrator } from "../../packages/gateway/src/symphony/orchestrator.js";
import type { SymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";
import type { SymphonyRun, SymphonySnapshot } from "../../packages/gateway/src/symphony/contracts.js";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";

function memoryRepo(snapshot: SymphonySnapshot): SymphonyRepository {
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  return {
    bootstrap: vi.fn(async () => undefined),
    resolveOwnerIdForOperator: vi.fn(async (userId) => userId),
    listEnabledOwnerIds: vi.fn(async () => snapshot.installation?.enabled ? [snapshot.installation.ownerId] : []),
    getSnapshot: vi.fn(async () => ({ ...snapshot, runs: Array.from(runs.values()) })),
    saveConfig: vi.fn(),
    setCredentialConfigured: vi.fn(),
    setEnabled: vi.fn(async (_ownerId, enabled) => {
      snapshot.installation = { ...snapshot.installation!, enabled };
      return snapshot.installation!;
    }),
    upsertRun: vi.fn(async (_ownerId, run: SymphonyRun) => {
      const active = Array.from(runs.values()).find((existing) =>
        existing.claimKey === run.claimKey && ["queued", "running", "retrying", "blocked"].includes(existing.status) && existing.id !== run.id);
      if (active) throw new Error("duplicate claim");
      runs.set(run.id, run);
      return run;
    }),
    updateRun: vi.fn(async (_ownerId, runId, patch) => {
      const current = runs.get(runId);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: "2026-05-13T00:00:00.000Z" };
      runs.set(runId, next);
      return next;
    }),
    getRun: vi.fn(async (_ownerId, runId) => runs.get(runId) ?? null),
    findActiveRunByClaim: vi.fn(async (_ownerId, claimKey) =>
      Array.from(runs.values()).find((run) => run.claimKey === claimKey && ["queued", "running", "retrying", "blocked"].includes(run.status)) ?? null),
    listRuns: vi.fn(async () => Array.from(runs.values())),
    appendEvent: vi.fn(async (_ownerId, event) => ({
      id: "evt_1",
      createdAt: "2026-05-13T00:00:00.000Z",
      ...event,
    })),
    recordPoll: vi.fn(async (_ownerId, at) => {
      snapshot.lastPollAt = at;
    }),
  } as unknown as SymphonyRepository;
}

describe("Matrix Symphony orchestrator", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-symphony-orchestrator-"));
    const repoPath = join(homePath, "projects", "matrix-os", "repo");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "WORKFLOW.md"), "Run the ticket and validate changes.");
    await atomicWriteJson(join(homePath, "projects", "matrix-os", "config.json"), {
      id: "proj_matrix",
      slug: "matrix-os",
      name: "Matrix OS",
      localPath: repoPath,
      addedAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  const baseSnapshot: SymphonySnapshot = {
    installation: {
      id: "sym_user_123",
      ownerId: "user_123",
      enabled: true,
      projectSlug: "matrix-os",
      credentialConfigured: true,
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 1,
      defaultAgent: "codex",
      authorizedOperators: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    },
    rule: {
      installationId: "sym_user_123",
      teamId: "team_1",
      teamKey: "MAT",
      requiredLabels: ["symphony"],
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      assigneeIds: ["assignee_1"],
      updatedAt: "2026-05-13T00:00:00.000Z",
    },
    runs: [],
    events: [],
    lastPollAt: null,
  };

  it("starts no more than the configured concurrency and creates no duplicate active claim", async () => {
    const repository = memoryRepo(structuredClone(baseSnapshot));
    const worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true as const, status: 201 as const, worktree: { id: "wt_abc123def456", path: "/repo/wt", projectSlug: "matrix-os" } })),
    };
    const agentSessionManager = {
      startSession: vi.fn(async () => ({ ok: true as const, status: 201 as const, session: { id: "sess_run_abc", runtime: { status: "running" } } })),
      killSession: vi.fn(),
    };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({
          truncated: false,
          tickets: [
            { externalId: "issue_1", identifier: "MAT-1", title: "One", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] },
            { externalId: "issue_2", identifier: "MAT-2", title: "Two", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] },
          ],
        })),
      },
      worktreeManager,
      agentSessionManager,
    });

    await orchestrator.poll("user_123");
    await orchestrator.poll("user_123");

    expect(worktreeManager.createWorktree).toHaveBeenCalledTimes(1);
    expect(agentSessionManager.startSession).toHaveBeenCalledTimes(1);
  });

  it("scopes generated run IDs by Matrix owner for shared Linear tickets", async () => {
    const snapshots = new Map<string, SymphonySnapshot>([
      ["owner_1", { ...structuredClone(baseSnapshot), installation: { ...baseSnapshot.installation!, ownerId: "owner_1", id: "sym_owner_1" } }],
      ["owner_2", { ...structuredClone(baseSnapshot), installation: { ...baseSnapshot.installation!, ownerId: "owner_2", id: "sym_owner_2" } }],
    ]);
    const runs = new Map<string, SymphonyRun>();
    const repository = {
      ...memoryRepo(structuredClone(baseSnapshot)),
      getSnapshot: vi.fn(async (ownerId: string) => ({ ...structuredClone(snapshots.get(ownerId)!), runs: Array.from(runs.values()).filter((run) => run.installationId === `sym_${ownerId}`) })),
      upsertRun: vi.fn(async (ownerId: string, run: SymphonyRun) => {
        runs.set(`${ownerId}:${run.id}`, run);
        return run;
      }),
      updateRun: vi.fn(async (ownerId: string, runId: string, patch: Partial<SymphonyRun>) => {
        const current = runs.get(`${ownerId}:${runId}`);
        if (!current) return null;
        const next = { ...current, ...patch, updatedAt: "2026-05-13T00:00:00.000Z" };
        runs.set(`${ownerId}:${runId}`, next);
        return next;
      }),
      findActiveRunByClaim: vi.fn(async (ownerId: string, claimKey: string) =>
        Array.from(runs.entries())
          .filter(([key]) => key.startsWith(`${ownerId}:`))
          .map(([, run]) => run)
          .find((run) => run.claimKey === claimKey && ["queued", "running", "retrying", "blocked"].includes(run.status)) ?? null),
      listRuns: vi.fn(async (ownerId: string) =>
        Array.from(runs.entries())
          .filter(([key]) => key.startsWith(`${ownerId}:`))
          .map(([, run]) => run)),
    } as unknown as SymphonyRepository;
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({
          truncated: false,
          tickets: [{ externalId: "issue_shared", identifier: "MAT-1", title: "Shared", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] }],
        })),
      },
      worktreeManager: {
        createWorktree: vi.fn(async () => ({ ok: true as const, status: 201 as const, worktree: { id: "wt_shared", path: "/repo/wt", projectSlug: "matrix-os" } })),
      },
      agentSessionManager: {
        startSession: vi.fn(async (input: { sessionId: string }) => ({ ok: true as const, status: 201 as const, session: { id: input.sessionId, runtime: { status: "running" } } })),
        killSession: vi.fn(),
      },
    });

    await orchestrator.poll("owner_1");
    await orchestrator.poll("owner_2");

    const ids = Array.from(runs.values()).map((run) => run.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("does not count already-running preview tickets against free capacity", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.installation = { ...snapshot.installation!, maxConcurrentAgents: 2 };
    snapshot.runs = [{
      id: "run_existing",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "One",
      status: "running",
      attempt: 1,
      agent: "codex",
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      lastEvent: "Agent session started",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }];
    const repository = memoryRepo(snapshot);
    const worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true as const, status: 201 as const, worktree: { id: "wt_next", path: "/repo/wt", projectSlug: "matrix-os" } })),
    };
    const agentSessionManager = {
      startSession: vi.fn(async () => ({ ok: true as const, status: 201 as const, session: { id: "sess_next", runtime: { status: "running" } } })),
      killSession: vi.fn(),
    };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({
          truncated: false,
          tickets: [
            { externalId: "issue_1", identifier: "MAT-1", title: "One", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] },
            { externalId: "issue_2", identifier: "MAT-2", title: "Two", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] },
          ],
        })),
      },
      worktreeManager,
      agentSessionManager,
    });

    await orchestrator.poll("user_123");

    expect(worktreeManager.createWorktree).toHaveBeenCalledTimes(1);
    expect(agentSessionManager.startSession).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent polls for the same owner", async () => {
    const repository = memoryRepo(structuredClone(baseSnapshot));
    const linearSource = {
      previewTickets: vi.fn(async () => ({
        truncated: false,
        tickets: [{ externalId: "issue_1", identifier: "MAT-1", title: "One", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] }],
      })),
    };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource,
      worktreeManager: {
        createWorktree: vi.fn(async () => ({ ok: true as const, status: 201 as const, worktree: { id: "wt_abc123def456", path: "/repo/wt", projectSlug: "matrix-os" } })),
      },
      agentSessionManager: {
        startSession: vi.fn(async () => ({ ok: true as const, status: 201 as const, session: { id: "sess_run_abc", runtime: { status: "running" } } })),
        killSession: vi.fn(),
      },
    });

    await Promise.all([orchestrator.poll("user_123"), orchestrator.poll("user_123")]);

    expect(linearSource.previewTickets).toHaveBeenCalledTimes(1);
  });

  it("dispatches queued retry claims instead of leaving them inert", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.runs = [{
      id: "run_existing",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "One",
      status: "retrying",
      attempt: 2,
      agent: "codex",
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      lastEvent: "Agent session could not be started",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }];
    const repository = memoryRepo(snapshot);
    const worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true as const, status: 200 as const, worktree: { id: "wt_retry", path: "/repo/wt", projectSlug: "matrix-os" } })),
    };
    const agentSessionManager = {
      startSession: vi.fn(async () => ({ ok: true as const, status: 201 as const, session: { id: "sess_retry", runtime: { status: "running" } } })),
      killSession: vi.fn(),
    };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({
          truncated: false,
          tickets: [{ externalId: "issue_1", identifier: "MAT-1", title: "One", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] }],
        })),
      },
      worktreeManager,
      agentSessionManager,
    });

    await orchestrator.poll("user_123");

    expect(worktreeManager.createWorktree).toHaveBeenCalledTimes(1);
    expect(agentSessionManager.startSession).toHaveBeenCalledTimes(1);
    await expect(repository.getRun("user_123", "run_existing")).resolves.toMatchObject({
      status: "running",
      sessionId: "sess_retry",
      attempt: 2,
    });
  });

  it("honors retry backoff before redispatching failed starts", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.runs = [{
      id: "run_existing",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "One",
      status: "retrying",
      attempt: 2,
      agent: "codex",
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      lastEvent: "Agent session could not be started",
      nextRetryAt: "2099-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }];
    const repository = memoryRepo(snapshot);
    const worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true as const, status: 200 as const, worktree: { id: "wt_retry", path: "/repo/wt", projectSlug: "matrix-os" } })),
    };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({
          truncated: false,
          tickets: [{ externalId: "issue_1", identifier: "MAT-1", title: "One", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] }],
        })),
      },
      worktreeManager,
      agentSessionManager: { startSession: vi.fn(), killSession: vi.fn() },
    });

    await expect(orchestrator.poll("user_123")).resolves.toMatchObject({ dispatched: 0 });

    expect(worktreeManager.createWorktree).not.toHaveBeenCalled();
  });

  it("keeps recurring poll timers isolated per owner", async () => {
    vi.useFakeTimers();
    try {
      const snapshots = new Map<string, SymphonySnapshot>([
        ["owner_1", { ...structuredClone(baseSnapshot), installation: { ...baseSnapshot.installation!, ownerId: "owner_1", id: "sym_owner_1", enabled: false } }],
        ["owner_2", { ...structuredClone(baseSnapshot), installation: { ...baseSnapshot.installation!, ownerId: "owner_2", id: "sym_owner_2", enabled: false } }],
      ]);
      const repository = {
        ...memoryRepo(structuredClone(baseSnapshot)),
        getSnapshot: vi.fn(async (ownerId: string) => structuredClone(snapshots.get(ownerId)!)),
        setEnabled: vi.fn(async (ownerId: string, enabled: boolean) => {
          const snapshot = snapshots.get(ownerId)!;
          snapshot.installation = { ...snapshot.installation!, enabled, pollIntervalMs: 1_000 };
          return snapshot.installation;
        }),
        recordPoll: vi.fn(async () => undefined),
        listRuns: vi.fn(async () => []),
        findActiveRunByClaim: vi.fn(async () => null),
      } as unknown as SymphonyRepository;
      const linearSource = { previewTickets: vi.fn(async () => ({ truncated: false, tickets: [] })) };
      const orchestrator = createMatrixSymphonyOrchestrator({
        homePath,
        repository,
        credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
        linearSource,
        worktreeManager: { createWorktree: vi.fn() },
        agentSessionManager: { startSession: vi.fn(), killSession: vi.fn() },
      });

      await orchestrator.start("owner_1", "owner_1");
      await orchestrator.start("owner_2", "owner_2");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(linearSource.previewTickets).toHaveBeenCalledTimes(2);

      await orchestrator.stop("owner_1", "owner_1");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(linearSource.previewTickets).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes polling for persisted enabled installations", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = structuredClone(baseSnapshot);
      snapshot.installation = { ...snapshot.installation!, enabled: true, pollIntervalMs: 1_000 };
      const repository = {
        ...memoryRepo(snapshot),
        listEnabledOwnerIds: vi.fn(async () => ["user_123"]),
      } as unknown as SymphonyRepository;
      const linearSource = { previewTickets: vi.fn(async () => ({ truncated: false, tickets: [] })) };
      const orchestrator = createMatrixSymphonyOrchestrator({
        homePath,
        repository,
        credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
        linearSource,
        worktreeManager: { createWorktree: vi.fn() },
        agentSessionManager: { startSession: vi.fn(), killSession: vi.fn() },
      });

      await expect(orchestrator.resumeEnabledInstallations()).resolves.toEqual(["user_123"]);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(linearSource.previewTickets).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks workflow failures as blocked attention states", async () => {
    const repository = memoryRepo(structuredClone(baseSnapshot));
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({
          truncated: false,
          tickets: [{ externalId: "issue_1", identifier: "MAT-1", title: "One", stateName: "Todo", assigneeId: "assignee_1", labels: ["symphony"] }],
        })),
      },
      worktreeManager: { createWorktree: vi.fn() },
      agentSessionManager: { startSession: vi.fn(), killSession: vi.fn() },
    });

    await orchestrator.poll("user_123");

    const runs = await repository.listRuns("user_123");
    expect(runs[0]).toMatchObject({ status: "blocked", lastErrorCode: "workflow_missing" });
  });

  it("kills an existing running session before retrying a run", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.runs = [{
      id: "run_existing",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "One",
      status: "running",
      attempt: 1,
      agent: "codex",
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      sessionId: "sess_existing",
      lastEvent: "Agent session started",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }];
    const repository = memoryRepo(snapshot);
    const agentSessionManager = {
      startSession: vi.fn(),
      killSession: vi.fn(async () => undefined),
    };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: { previewTickets: vi.fn() },
      worktreeManager: { createWorktree: vi.fn() },
      agentSessionManager,
    });

    await orchestrator.retryRun("user_123", "run_existing", "user_123");

    expect(agentSessionManager.killSession).toHaveBeenCalledWith("sess_existing");
    await expect(repository.getRun("user_123", "run_existing")).resolves.toMatchObject({
      status: "queued",
      attempt: 2,
    });
  });

  it("keeps a stopped run in attention state when session kill fails", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.runs = [{
      id: "run_existing",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "One",
      status: "running",
      attempt: 1,
      agent: "codex",
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      sessionId: "sess_existing",
      lastEvent: "Agent session started",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }];
    const repository = memoryRepo(snapshot);
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: { previewTickets: vi.fn() },
      worktreeManager: { createWorktree: vi.fn() },
      agentSessionManager: {
        startSession: vi.fn(),
        killSession: vi.fn(async () => ({ ok: false as const, status: 503, error: { code: "runtime_unavailable", message: "Runtime unavailable" } })),
      },
    });

    await orchestrator.stopRun("user_123", "run_existing", "user_123");

    await expect(repository.getRun("user_123", "run_existing")).resolves.toMatchObject({
      status: "blocked",
      lastErrorCode: "runtime_unavailable",
    });
  });

  it("stops running agents whose ticket no longer matches the active Linear filter", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.runs = [{
      id: "run_existing",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "One",
      status: "running",
      attempt: 1,
      agent: "codex",
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      sessionId: "sess_existing",
      lastEvent: "Agent session started",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }];
    const repository = memoryRepo(snapshot);
    const agentSessionManager = {
      startSession: vi.fn(),
      killSession: vi.fn(async () => ({ ok: true as const, session: { id: "sess_existing", runtime: { status: "exited" } } })),
    };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({ truncated: false, tickets: [] })),
      },
      worktreeManager: { createWorktree: vi.fn() },
      agentSessionManager,
    });

    await orchestrator.poll("user_123");

    expect(agentSessionManager.killSession).toHaveBeenCalledWith("sess_existing");
    await expect(repository.getRun("user_123", "run_existing")).resolves.toMatchObject({
      status: "stopped",
      lastEvent: "Ticket no longer matches Symphony rule",
    });
  });
});
