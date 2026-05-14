import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixSymphonyOrchestrator } from "../../packages/gateway/src/symphony/orchestrator.js";
import type { SymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";
import type { SymphonyRun, SymphonySnapshot } from "../../packages/gateway/src/symphony/contracts.js";

function repo(snapshot: SymphonySnapshot): SymphonyRepository {
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  return {
    bootstrap: vi.fn(),
    resolveOwnerIdForOperator: vi.fn(async (id) => id),
    listEnabledOwnerIds: vi.fn(async () => []),
    getSnapshot: vi.fn(async () => ({ ...snapshot, runs: Array.from(runs.values()) })),
    saveConfig: vi.fn(),
    setCredentialConfigured: vi.fn(),
    setEnabled: vi.fn(),
    upsertRun: vi.fn(async (_ownerId, run) => {
      runs.set(run.id, run);
      return run;
    }),
    updateRun: vi.fn(async (_ownerId, runId, patch) => {
      const current = runs.get(runId);
      if (!current) return null;
      const next = { ...current, ...patch } as SymphonyRun;
      runs.set(runId, next);
      return next;
    }),
    getRun: vi.fn(async (_ownerId, runId) => runs.get(runId) ?? null),
    findActiveRunByClaim: vi.fn(async (_ownerId, claimKey) => Array.from(runs.values()).find((run) => run.claimKey === claimKey && run.status === "running") ?? null),
    listRuns: vi.fn(async () => Array.from(runs.values())),
    appendEvent: vi.fn(async (_ownerId, event) => ({ id: "evt_1", createdAt: "2026-05-14T18:00:00.000Z", ...event })),
    recordPoll: vi.fn(),
  } as unknown as SymphonyRepository;
}

const snapshot: SymphonySnapshot = {
  installation: {
    id: "sym_user_123",
    ownerId: "user_123",
    enabled: true,
    projectSlug: "repo",
    credentialConfigured: true,
    pollIntervalMs: 30_000,
    maxConcurrentAgents: 3,
    defaultAgent: "codex",
    authorizedOperators: [],
    createdAt: "2026-05-14T18:00:00.000Z",
    updatedAt: "2026-05-14T18:00:00.000Z",
  },
  rule: null,
  runs: [],
  events: [],
  lastPollAt: null,
};

describe("Symphony ticket assignment", () => {
  let worktreeManager: { createWorktree: ReturnType<typeof vi.fn> };
  let agentSessionManager: { startSession: ReturnType<typeof vi.fn>; killSession: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true, worktree: { id: "wt_ticket", path: "/cloud/wt" } })),
    };
    agentSessionManager = {
      startSession: vi.fn(async () => ({ ok: true, session: { id: "sess_ticket" } })),
      killSession: vi.fn(),
    };
  });

  it("assigns a Matrix-native ticket into a cloud worktree/session claim", async () => {
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository: repo(structuredClone(snapshot)),
      credentialStore: { readLinearCredential: vi.fn(), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: { previewTickets: vi.fn() },
      worktreeManager,
      agentSessionManager,
      loadWorkflow: vi.fn(async () => ({ projectSlug: "repo", path: "/tmp/WORKFLOW.md", body: "Run tests", lastLoadedAt: "2026-05-14T18:00:00.000Z" })),
    });

    const run = await orchestrator.assignTicket("user_123", {
      sourceKind: "matrix",
      externalId: "ticket_123",
      identifier: "MAT-123",
      title: "Build Matrix ticket assignment",
      stateName: "Todo",
      labels: ["symphony"],
    }, "user_123");

    expect(run).toMatchObject({
      status: "running",
      claimKey: "matrix:ticket_123",
      ticketIdentifier: "MAT-123",
      ticketSourceKind: "matrix",
      trackedTicketId: "ticket_123",
    });
    expect(worktreeManager.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ branch: "symphony/mat-123" }));
    expect(agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex", projectSlug: "repo" }));
  });

  it("rejects manual assignment when active runs already consume agent capacity", async () => {
    const currentSnapshot = structuredClone(snapshot);
    currentSnapshot.installation!.maxConcurrentAgents = 1;
    currentSnapshot.runs = [{
      id: "run_existing",
      installationId: "sym_user_123",
      ticketExternalId: "ticket_001",
      ticketSourceKind: "matrix",
      trackedTicketId: "ticket_001",
      ticketIdentifier: "MAT-1",
      ticketTitle: "Existing run",
      status: "running",
      attempt: 1,
      agent: "codex",
      projectSlug: "repo",
      sessionId: "sess_existing",
      claimKey: "matrix:ticket_001",
      lastEvent: "Agent session started",
      updatedAt: "2026-05-14T18:00:00.000Z",
    }];
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository: repo(currentSnapshot),
      credentialStore: { readLinearCredential: vi.fn(), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: { previewTickets: vi.fn() },
      worktreeManager,
      agentSessionManager,
      loadWorkflow: vi.fn(async () => ({ projectSlug: "repo", path: "/tmp/WORKFLOW.md", body: "Run tests", lastLoadedAt: "2026-05-14T18:00:00.000Z" })),
    });

    const run = await orchestrator.assignTicket("user_123", {
      sourceKind: "matrix",
      externalId: "ticket_123",
      identifier: "MAT-123",
      title: "Build Matrix ticket assignment",
      stateName: "Todo",
      labels: ["symphony"],
    }, "user_123");

    expect(run).toBeNull();
    expect(worktreeManager.createWorktree).not.toHaveBeenCalled();
    expect(agentSessionManager.startSession).not.toHaveBeenCalled();
  });

  it("reuses legacy Linear run ids before dispatching a duplicate blocked run", async () => {
    const legacyRunId = `run_${createHash("sha256").update("user_123:issue_123").digest("hex").slice(0, 16)}`;
    const legacyRun: SymphonyRun = {
      id: legacyRunId,
      installationId: "sym_user_123",
      ticketExternalId: "issue_123",
      ticketSourceKind: "linear",
      ticketIdentifier: "LIN-123",
      ticketTitle: "Existing Linear dispatch",
      status: "blocked",
      attempt: 1,
      agent: "codex",
      projectSlug: "repo",
      claimKey: "linear:issue_123",
      lastEvent: "Needs attention",
      updatedAt: "2026-05-14T18:00:00.000Z",
    };
    const currentSnapshot = structuredClone(snapshot);
    currentSnapshot.runs = [legacyRun];
    const repository = repo(currentSnapshot);
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository,
      credentialStore: { readLinearCredential: vi.fn(), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: { previewTickets: vi.fn() },
      worktreeManager,
      agentSessionManager,
      loadWorkflow: vi.fn(async () => ({ projectSlug: "repo", path: "/tmp/WORKFLOW.md", body: "Run tests", lastLoadedAt: "2026-05-14T18:00:00.000Z" })),
    });

    const run = await orchestrator.assignTicket("user_123", {
      sourceKind: "linear",
      externalId: "issue_123",
      identifier: "LIN-123",
      title: "Existing Linear dispatch",
      stateName: "Todo",
      labels: ["symphony"],
    }, "user_123");

    expect(run).toMatchObject({ id: legacyRunId, status: "blocked" });
    expect(repository.upsertRun).not.toHaveBeenCalled();
    expect(worktreeManager.createWorktree).not.toHaveBeenCalled();
    expect(agentSessionManager.startSession).not.toHaveBeenCalled();
  });
});
