import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";
import { composeSymphonyPrompt, loadWorkflowContract, SymphonyWorkflowError } from "../../packages/gateway/src/symphony/prompt.js";
import { createMatrixSymphonyOrchestrator } from "../../packages/gateway/src/symphony/orchestrator.js";
import type { SymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";
import type { SymphonyRun, SymphonySnapshot } from "../../packages/gateway/src/symphony/contracts.js";

describe("Symphony workflow", () => {
  let homePath: string;
  let repoPath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-symphony-workflow-"));
    repoPath = join(homePath, "projects", "matrix-os", "repo");
    await mkdir(repoPath, { recursive: true });
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

  it("loads workflow policy inside the selected Matrix project", async () => {
    await writeFile(join(repoPath, "WORKFLOW.md"), "Run tests before handoff.");

    await expect(loadWorkflowContract({ homePath, projectSlug: "matrix-os" })).resolves.toMatchObject({
      projectSlug: "matrix-os",
      body: "Run tests before handoff.",
    });
  });

  it("creates a default workflow contract in registered projects when none exists", async () => {
    const workflow = await loadWorkflowContract({ homePath, projectSlug: "matrix-os" });

    expect(workflow).toMatchObject({
      projectSlug: "matrix-os",
      path: join(repoPath, "WORKFLOW.md"),
    });
    expect(workflow.body).toContain("Matrix Symphony workflow");
    await expect(readFile(join(repoPath, "WORKFLOW.md"), "utf8")).resolves.toContain("Matrix Symphony workflow");
  });

  it("rejects workflow paths outside the Matrix project", async () => {
    await expect(loadWorkflowContract({ homePath, projectSlug: "matrix-os", workflowPath: "../secret.md" }))
      .rejects.toBeInstanceOf(SymphonyWorkflowError);
  });

  it("reports a clear setup error when a custom workflow path is missing", async () => {
    await expect(loadWorkflowContract({ homePath, projectSlug: "matrix-os", workflowPath: "docs/WORKFLOW.md" }))
      .rejects.toMatchObject({ code: "workflow_missing" });
  });

  it("composes prompt from workflow and ticket context without secrets", () => {
    const prompt = composeSymphonyPrompt({
      workflow: {
        projectSlug: "matrix-os",
        path: "/repo/WORKFLOW.md",
        body: "Follow WORKFLOW.md.",
        lastLoadedAt: "2026-05-13T00:00:00.000Z",
      },
      ticket: {
        externalId: "issue_1",
        identifier: "MAT-1",
        title: "Build Matrix Symphony",
        stateName: "Todo",
        assigneeName: "Hamed",
        labels: ["symphony"],
      },
      attempt: 1,
    });

    expect(prompt).toContain("Follow WORKFLOW.md.");
    expect(prompt).toContain("MAT-1");
    expect(prompt).toContain("Build Matrix Symphony");
    expect(prompt).not.toContain("lin_api");
  });

  it("reuses an active claim when a duplicate run appears before dispatch starts", async () => {
    const snapshot: SymphonySnapshot = {
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
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      rule: {
        installationId: "sym_user_123",
        teamId: "team_1",
        teamKey: "MAT",
        requiredLabels: ["symphony"],
        activeStates: ["Todo"],
        terminalStates: ["Done"],
        assigneeIds: [],
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      runs: [],
      events: [],
      lastPollAt: null,
    };
    const runs = new Map<string, SymphonyRun>();
    const repository: SymphonyRepository = {
      bootstrap: async () => undefined,
      resolveOwnerIdForOperator: async (userId) => userId,
      listEnabledOwnerIds: async () => ["user_123"],
      getSnapshot: async () => ({ ...snapshot, runs: Array.from(runs.values()) }),
      saveConfig: async () => {
        throw new Error("not used");
      },
      setCredentialConfigured: async () => undefined,
      setEnabled: async () => snapshot.installation!,
      upsertRun: async (_ownerId, run) => {
        const duplicate: SymphonyRun = {
          ...run,
          id: "run_existing",
          status: "running",
          sessionId: "sess_existing",
          worktreeId: "wt_existing",
          lastEvent: "Agent session started elsewhere",
        };
        runs.set(duplicate.id, duplicate);
        throw new Error("duplicate claim");
      },
      updateRun: async (_ownerId, runId, patch) => {
        const current = runs.get(runId);
        if (!current) return null;
        const next = { ...current, ...patch };
        runs.set(runId, next);
        return next;
      },
      getRun: async (_ownerId, runId) => runs.get(runId) ?? null,
      findActiveRunByClaim: async (_ownerId, claimKey) =>
        Array.from(runs.values()).find((run) =>
          run.claimKey === claimKey && ["queued", "running", "retrying", "blocked"].includes(run.status)
        ) ?? null,
      listRuns: async (_ownerId, input) =>
        Array.from(runs.values()).filter((run) => !input?.status || run.status === input.status),
      appendEvent: async (_ownerId, event) => {
        if (event.type === "symphony.run.reused") {
          throw new Error("event log unavailable");
        }
        return { id: "evt_1", createdAt: "2026-05-23T00:00:00.000Z", ...event };
      },
      recordPoll: async (_ownerId, at) => {
        snapshot.lastPollAt = at;
      },
    };
    const worktreeManager = { createWorktree: vi.fn() };
    const agentSessionManager = { startSession: vi.fn(), killSession: vi.fn() };
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore: { readLinearCredential: vi.fn(async () => "lin_api_secret"), hasLinearCredential: vi.fn(), writeLinearCredential: vi.fn(), deleteLinearCredential: vi.fn() },
      linearSource: {
        previewTickets: vi.fn(async () => ({
          truncated: false,
          tickets: [{ externalId: "issue_1", identifier: "MAT-1", title: "Build", stateName: "Todo", labels: ["symphony"] }],
        })),
      },
      worktreeManager,
      agentSessionManager,
    });

    await expect(orchestrator.poll("user_123")).resolves.toMatchObject({ dispatched: 1, skipped: 0 });

    expect(worktreeManager.createWorktree).not.toHaveBeenCalled();
    expect(agentSessionManager.startSession).not.toHaveBeenCalled();
    expect(Array.from(runs.values())).toHaveLength(1);
  });
});
