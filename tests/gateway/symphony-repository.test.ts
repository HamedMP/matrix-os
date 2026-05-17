import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { Kysely } from "kysely";
import { KyselySymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";
import { MAX_EVENTS } from "../../packages/gateway/src/symphony/contracts.js";

describe("Symphony repository", () => {
  let instance: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<any>;
  let repository: KyselySymphonyRepository;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = new Kysely<any>({ dialect: instance.dialect });
    repository = new KyselySymphonyRepository(db);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("saves installation, rule, and audit event in one transaction", async () => {
    await repository.saveConfig("user_123", {
      installation: {
        projectSlug: "matrix-os",
        pollIntervalMs: 30_000,
        maxConcurrentAgents: 3,
        defaultAgent: "codex",
        authorizedOperators: ["user_456"],
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

    const snapshot = await repository.getSnapshot("user_123");

    expect(snapshot.installation).toMatchObject({
      ownerId: "user_123",
      credentialConfigured: true,
      projectSlug: "matrix-os",
      authorizedOperators: ["user_456"],
    });
    expect(snapshot.rule).toMatchObject({ teamKey: "MAT", assigneeIds: ["linear_user"] });
    expect(snapshot.events).toEqual([expect.objectContaining({ type: "symphony.config.updated", actorId: "user_123" })]);
  });

  it("enforces one active claim per ticket", async () => {
    const run = {
      id: "run_1",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "Build Symphony",
      status: "running" as const,
      attempt: 1,
      agent: "codex" as const,
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      lastEvent: "running",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    await repository.upsertRun("user_123", run);

    await expect(repository.upsertRun("user_123", { ...run, id: "run_2" })).rejects.toThrow();
    await repository.updateRun("user_123", "run_1", { status: "completed" });
    await expect(repository.upsertRun("user_123", { ...run, id: "run_2" })).resolves.toMatchObject({ id: "run_2" });
  });

  it("keeps stale status transitions from overwriting newer run state", async () => {
    const run = {
      id: "run_1",
      installationId: "sym_user_123",
      ticketExternalId: "issue_1",
      ticketIdentifier: "MAT-1",
      ticketTitle: "Build Symphony",
      status: "queued" as const,
      attempt: 1,
      agent: "codex" as const,
      projectSlug: "matrix-os",
      claimKey: "linear:issue_1",
      lastEvent: "queued",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    await repository.upsertRun("user_123", run);
    await repository.updateRun("user_123", "run_1", { status: "stopped" });

    await expect(repository.updateRun("user_123", "run_1", {
      status: "running",
      sessionId: "sess_1",
      lastEvent: "Agent session started",
    }, { allowedStatuses: ["queued", "retrying"] })).resolves.toBeNull();
    await expect(repository.getRun("user_123", "run_1")).resolves.toMatchObject({
      status: "stopped",
    });
  });

  it("prunes stored events per owner after inserts", async () => {
    await repository.appendEvent("owner_other", {
      id: "evt_other",
      installationId: "sym_owner_other",
      type: "symphony.poll.completed",
      message: "Other owner event",
      severity: "info",
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    for (let index = 0; index < MAX_EVENTS + 5; index += 1) {
      await repository.appendEvent("user_123", {
        id: `evt_${index.toString().padStart(3, "0")}`,
        installationId: "sym_user_123",
        type: "symphony.poll.completed",
        message: `Poll ${index}`,
        severity: "info",
        createdAt: new Date(Date.UTC(2026, 4, 13, 0, 0, index)).toISOString(),
      });
    }

    const ownerCount = await db
      .selectFrom("symphony_events")
      .select(({ fn }) => fn.count<number>("id").as("count"))
      .where("owner_id", "=", "user_123")
      .executeTakeFirstOrThrow();
    const otherCount = await db
      .selectFrom("symphony_events")
      .select(({ fn }) => fn.count<number>("id").as("count"))
      .where("owner_id", "=", "owner_other")
      .executeTakeFirstOrThrow();
    const snapshot = await repository.getSnapshot("user_123");

    expect(Number(ownerCount.count)).toBe(MAX_EVENTS);
    expect(Number(otherCount.count)).toBe(1);
    expect(snapshot.events).toHaveLength(MAX_EVENTS);
    expect(snapshot.events[0]).toMatchObject({ id: "evt_005" });
  });

  it("resolves authorized operators from the indexed operator table", async () => {
    await repository.saveConfig("user_123", {
      installation: {
        projectSlug: "matrix-os",
        pollIntervalMs: 30_000,
        maxConcurrentAgents: 3,
        defaultAgent: "codex",
        authorizedOperators: ["user_456"],
      },
      rule: {
        teamId: "team_123",
        teamKey: "MAT",
        requiredLabels: ["symphony"],
        activeStates: ["Todo"],
        terminalStates: ["Done"],
        assigneeIds: [],
      },
    }, "user_123", false);

    await expect(repository.resolveOwnerIdForOperator("user_456")).resolves.toBe("user_123");

    await repository.saveConfig("user_123", {
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
        assigneeIds: [],
      },
    }, "user_123", false);

    await expect(repository.resolveOwnerIdForOperator("user_456")).resolves.toBeNull();
  });
});
