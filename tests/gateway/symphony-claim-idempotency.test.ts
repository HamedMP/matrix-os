import { describe, expect, it, vi } from "vitest";
import { createMatrixSymphonyOrchestrator } from "../../packages/gateway/src/symphony/orchestrator.js";
import type { SymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";
import type { SymphonyRun, SymphonySnapshot } from "../../packages/gateway/src/symphony/contracts.js";

describe("Symphony duplicate ticket claims", () => {
  it("returns the active run for repeated manual assignments", async () => {
    const runs = new Map<string, SymphonyRun>();
    const snapshot: SymphonySnapshot = {
      installation: { id: "sym_user_123", ownerId: "user_123", enabled: true, projectSlug: "repo", credentialConfigured: true, pollIntervalMs: 30_000, maxConcurrentAgents: 3, defaultAgent: "codex", authorizedOperators: [], createdAt: "now", updatedAt: "now" },
      rule: null,
      runs: [],
      events: [],
      lastPollAt: null,
    };
    const repository = {
      getSnapshot: vi.fn(async () => ({ ...snapshot, runs: Array.from(runs.values()) })),
      upsertRun: vi.fn(async (_ownerId: string, run: SymphonyRun) => {
        runs.set(run.id, run);
        return run;
      }),
      updateRun: vi.fn(async (_ownerId: string, runId: string, patch: Partial<SymphonyRun>) => {
        const next = { ...runs.get(runId)!, ...patch } as SymphonyRun;
        runs.set(runId, next);
        return next;
      }),
      getRun: vi.fn(async (_ownerId: string, runId: string) => runs.get(runId) ?? null),
      findActiveRunByClaim: vi.fn(async (_ownerId: string, claimKey: string) => Array.from(runs.values()).find((run) => run.claimKey === claimKey && run.status === "running") ?? null),
      appendEvent: vi.fn(async (_ownerId: string, event: any) => ({ id: "evt_1", createdAt: "now", ...event })),
    } as unknown as SymphonyRepository;
    const startSession = vi.fn(async () => ({ ok: true, session: { id: "sess_ticket" } }));
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository,
      credentialStore: { readLinearCredential: vi.fn(), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: { previewTickets: vi.fn() },
      worktreeManager: { createWorktree: vi.fn(async () => ({ ok: true, worktree: { id: "wt_ticket", path: "/cloud/wt" } })) },
      agentSessionManager: { startSession, killSession: vi.fn() },
      loadWorkflow: vi.fn(async () => ({ projectSlug: "repo", path: "/tmp/WORKFLOW.md", body: "Run tests", lastLoadedAt: "2026-05-14T18:00:00.000Z" })),
    });
    const ticket = { sourceKind: "matrix" as const, externalId: "ticket_123", identifier: "MAT-123", title: "One", stateName: "Todo", labels: [] };

    const first = await orchestrator.assignTicket("user_123", ticket, "user_123");
    const second = await orchestrator.assignTicket("user_123", ticket, "user_123");

    expect(second.id).toBe(first.id);
    expect(startSession).toHaveBeenCalledTimes(1);
  });
});
