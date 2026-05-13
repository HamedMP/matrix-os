import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { Kysely } from "kysely";
import { KyselySymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";

describe("Symphony restart recovery", () => {
  let instance: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<any>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = new Kysely<any>({ dialect: instance.dialect });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("reconstructs persisted config and stale active runs after repository re-bootstrap", async () => {
    const first = new KyselySymphonyRepository(db);
    await first.bootstrap();
    await first.saveConfig("user_123", {
      installation: {
        projectSlug: "matrix-os",
        pollIntervalMs: 30_000,
        maxConcurrentAgents: 3,
        defaultAgent: "codex",
        authorizedOperators: [],
      },
      rule: {
        teamId: "team_123",
        teamKey: "MAT",
        requiredLabels: ["symphony"],
        activeStates: ["Todo"],
        terminalStates: ["Done"],
        assigneeIds: ["linear_user"],
      },
    }, "user_123", true);
    await first.upsertRun("user_123", {
      id: "run_1",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "Build Symphony",
      status: "running",
      attempt: 1,
      agent: "codex",
      projectSlug: "matrix-os",
      worktreeId: "wt_abc123def456",
      sessionId: "sess_run_1",
      claimKey: "linear:issue_1",
      lastEvent: "Agent session started",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });

    const afterRestart = new KyselySymphonyRepository(db);
    await afterRestart.bootstrap();
    const snapshot = await afterRestart.getSnapshot("user_123");

    expect(snapshot.installation).toMatchObject({ projectSlug: "matrix-os", credentialConfigured: true });
    expect(snapshot.rule).toMatchObject({ assigneeIds: ["linear_user"] });
    expect(snapshot.runs).toEqual([expect.objectContaining({ id: "run_1", status: "running", worktreeId: "wt_abc123def456" })]);
  });
});
