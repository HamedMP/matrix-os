import { describe, expect, it, vi } from "vitest";
import { createMatrixSymphonyRoutes } from "../../packages/gateway/src/symphony/routes.js";
import type { SymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";
import type { SymphonyInstallation, SymphonyRun, SymphonySnapshot } from "../../packages/gateway/src/symphony/contracts.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

function jsonRequest(path: string, method: "POST" | "DELETE", body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deps(snapshot: SymphonySnapshot, principal: RequestPrincipal = { userId: "user_123", source: "dev-default" }) {
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const credentialStore = {
    hasLinearCredential: vi.fn(async () => Boolean(snapshot.installation?.credentialConfigured)),
    readLinearCredential: vi.fn(async () => snapshot.installation?.credentialConfigured ? "lin_api_secret" : null),
    writeLinearCredential: vi.fn(async () => undefined),
    deleteLinearCredential: vi.fn(async () => undefined),
  };
  const repository: SymphonyRepository = {
    bootstrap: vi.fn(async () => undefined),
    resolveOwnerIdForOperator: vi.fn(async (userId) => {
      if (snapshot.installation?.ownerId === userId) return userId;
      if (snapshot.installation?.authorizedOperators.includes(userId)) return snapshot.installation.ownerId;
      return null;
    }),
    listEnabledOwnerIds: vi.fn(async () => snapshot.installation?.enabled ? [snapshot.installation.ownerId] : []),
    getSnapshot: vi.fn(async () => ({ ...snapshot, runs: Array.from(runs.values()) })),
    saveConfig: vi.fn(async (ownerId, input, _actorId, credentialConfigured) => {
      const installation: SymphonyInstallation = {
        id: `sym_${ownerId}`,
        ownerId,
        enabled: false,
        credentialConfigured,
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
        ...input.installation,
      };
      snapshot.installation = installation;
      snapshot.rule = { ...input.rule, installationId: installation.id, updatedAt: installation.updatedAt };
      return { installation, rule: snapshot.rule };
    }),
    setCredentialConfigured: vi.fn(async (_ownerId, configured) => {
      snapshot.installation = { ...snapshot.installation!, credentialConfigured: configured };
    }),
    setEnabled: vi.fn(async (_ownerId, enabled) => {
      snapshot.installation = { ...snapshot.installation!, enabled };
      return snapshot.installation!;
    }),
    upsertRun: vi.fn(async (_ownerId, run) => {
      runs.set(run.id, run);
      return run;
    }),
    updateRun: vi.fn(async (_ownerId, runId, patch) => {
      const current = runs.get(runId);
      if (!current) return null;
      const updated = { ...current, ...patch } as SymphonyRun;
      runs.set(runId, updated);
      return updated;
    }),
    getRun: vi.fn(async (_ownerId, runId) => runs.get(runId) ?? null),
    findActiveRunByClaim: vi.fn(),
    listRuns: vi.fn(async (_ownerId, input = {}) => Array.from(runs.values()).filter((run) => !input.status || run.status === input.status)),
    appendEvent: vi.fn(async (_ownerId, event) => ({ id: "evt_1", createdAt: "2026-05-13T00:00:00.000Z", ...event })),
    recordPoll: vi.fn(),
  };
  const orchestrator = {
    start: vi.fn(async () => ({ ...snapshot.installation!, enabled: true })),
    stop: vi.fn(async () => ({ ...snapshot.installation!, enabled: false })),
    poll: vi.fn(async () => ({ matchedTickets: 0, dispatched: 0, skipped: 0 })),
    stopRun: vi.fn(async (_ownerId: string, runId: string) => repository.updateRun("user_123", runId, { status: "stopped" })),
    retryRun: vi.fn(async (_ownerId: string, runId: string) => repository.updateRun("user_123", runId, { status: "queued" })),
    shutdown: vi.fn(),
    resumeEnabledInstallations: vi.fn(async () => []),
    idForNewRun: vi.fn(),
  };
  const linearSource = {
    previewTickets: vi.fn(async () => ({ tickets: [{ externalId: "issue_1", identifier: "MAT-1", title: "Build", stateName: "Todo", labels: ["symphony"] }], truncated: false })),
  };
  return {
    app: createMatrixSymphonyRoutes({
      repository,
      credentialStore,
      linearSource,
      orchestrator,
      getPrincipal: () => principal,
    }),
    repository,
    credentialStore,
    linearSource,
    orchestrator,
  };
}

const baseSnapshot: SymphonySnapshot = {
  installation: {
    id: "sym_user_123",
    ownerId: "user_123",
    enabled: false,
    credentialConfigured: true,
    projectSlug: "matrix-os",
    pollIntervalMs: 30_000,
    maxConcurrentAgents: 3,
    defaultAgent: "codex",
    authorizedOperators: ["user_456"],
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
    assigneeIds: ["linear_user"],
    updatedAt: "2026-05-13T00:00:00.000Z",
  },
  runs: [{
    id: "run_1",
    installationId: "sym_user_123",
    ticketExternalId: "issue_1",
    ticketIdentifier: "MAT-1",
    ticketTitle: "Build",
    status: "running",
    attempt: 1,
    agent: "codex",
    projectSlug: "matrix-os",
    claimKey: "linear:issue_1",
    lastEvent: "Agent session started",
    updatedAt: "2026-05-13T00:00:00.000Z",
  }],
  events: [],
  lastPollAt: null,
};

describe("Matrix Symphony routes", () => {
  it("returns sanitized status without secrets", async () => {
    const { app } = deps(structuredClone(baseSnapshot));

    const res = await app.request("/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ credentialConfigured: true, counts: { running: 1 } });
    expect(JSON.stringify(body)).not.toContain("lin_api");
  });

  it("saves config and never returns the Linear secret", async () => {
    const { app, repository } = deps(structuredClone(baseSnapshot));

    const res = await app.request(jsonRequest("/config", "POST", {
      installation: {
        projectSlug: "matrix-os",
        pollIntervalMs: 30000,
        maxConcurrentAgents: 3,
        defaultAgent: "codex",
        authorizedOperators: ["user_456"],
      },
      rule: {
        teamId: "team_1",
        teamKey: "MAT",
        requiredLabels: ["symphony"],
        activeStates: ["Todo"],
        terminalStates: ["Done"],
        assigneeIds: ["linear_user"],
      },
    }));

    expect(res.status).toBe(200);
    expect(repository.saveConfig).toHaveBeenCalledOnce();
    expect(JSON.stringify(await res.json())).not.toContain("lin_api");
  });

  it("lets delegated operators create their own owner config", async () => {
    const { app, repository } = deps(structuredClone(baseSnapshot), { userId: "user_456", source: "dev-default" });
    vi.mocked(repository.getSnapshot).mockImplementation(async (ownerId: string) => ownerId === "user_456"
      ? { installation: null, rule: null, runs: [], events: [], lastPollAt: null }
      : structuredClone(baseSnapshot));

    const res = await app.request(jsonRequest("/config", "POST", {
      installation: {
        projectSlug: "matrix-os",
        pollIntervalMs: 30000,
        maxConcurrentAgents: 3,
        defaultAgent: "codex",
        authorizedOperators: [],
      },
      rule: {
        teamId: "team_2",
        teamKey: "OWN",
        requiredLabels: ["symphony"],
        activeStates: ["Todo"],
        terminalStates: ["Done"],
        assigneeIds: [],
      },
    }));

    expect(res.status).toBe(200);
    expect(repository.saveConfig).toHaveBeenCalledWith("user_456", expect.any(Object), "user_456", expect.any(Boolean));
  });

  it("stores Linear credentials server-side and returns only presence", async () => {
    const { app, credentialStore } = deps(structuredClone(baseSnapshot));

    const res = await app.request(jsonRequest("/credentials/linear", "POST", { kind: "api_key", secret: "lin_api_secret" }));

    expect(res.status).toBe(200);
    expect(credentialStore.writeLinearCredential).toHaveBeenCalledWith("user_123", "lin_api_secret");
    expect(await res.json()).toEqual({ credentialConfigured: true, accountLabel: "Linear" });
  });

  it("rejects unauthorized users without run details", async () => {
    const { app } = deps(structuredClone(baseSnapshot), { userId: "user_999", source: "dev-default" });

    const res = await app.request("/runs");

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("MAT-1");
  });

  it("previews tickets through the server-side credential", async () => {
    const { app, linearSource } = deps(structuredClone(baseSnapshot));

    const res = await app.request("/tickets/preview?limit=10");

    expect(res.status).toBe(200);
    expect(linearSource.previewTickets).toHaveBeenCalledWith(expect.any(Object), "lin_api_secret", { limit: 10 });
    expect(await res.json()).toMatchObject({ tickets: [{ identifier: "MAT-1" }] });
  });

  it("performs run actions with validated action payloads", async () => {
    const { app, orchestrator } = deps(structuredClone(baseSnapshot));

    const res = await app.request(jsonRequest("/runs/run_1/actions", "POST", { type: "stop" }));

    expect(res.status).toBe(200);
    expect(orchestrator.stopRun).toHaveBeenCalledWith("user_123", "run_1", "user_123");
    expect(await res.json()).toMatchObject({ run: { status: "stopped" } });
  });

  it("returns start success even when the immediate poll fails after enabling", async () => {
    const { app, orchestrator } = deps(structuredClone(baseSnapshot));
    orchestrator.poll = vi.fn(async () => {
      throw new Error("linear_unavailable");
    });

    const res = await app.request(jsonRequest("/start", "POST", {}));

    expect(res.status).toBe(200);
    expect(orchestrator.start).toHaveBeenCalledWith("user_123", "user_123");
    expect(orchestrator.poll).toHaveBeenCalledWith("user_123");
    expect(await res.json()).toMatchObject({ running: true, installationId: "sym_user_123" });
  });
});
