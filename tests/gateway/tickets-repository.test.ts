import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { KyselyTicketRepository } from "../../packages/gateway/src/tickets/internal-repository.js";

describe("Ticket repository", () => {
  let instance: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<any>;
  let repository: KyselyTicketRepository;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = new Kysely<any>({ dialect: instance.dialect });
    repository = new KyselyTicketRepository(db, () => "2026-05-14T18:00:00.000Z");
    await repository.bootstrap();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates Matrix-native tickets and updates them with optimistic revisions", async () => {
    const created = await repository.createInternalTicket("user_123", "repo", {
      title: "Build ticket board",
      description: "Unified Matrix and Linear tickets",
      status: "Todo",
      priority: "high",
      assigneeIds: ["hamed"],
      labelIds: ["desktop"],
    });

    expect(created).toMatchObject({
      projectSlug: "repo",
      sourceKind: "matrix",
      identifier: expect.stringMatching(/^MAT-\d+$/),
      revision: 1,
      syncStatus: "local",
    });

    const updated = await repository.updateTicket("user_123", "repo", created.id, {
      baseRevision: 1,
      patch: { status: "In Progress", labelIds: ["desktop", "cloud"] },
    });
    expect(updated).toMatchObject({ status: "In Progress", revision: 2, labelIds: ["desktop", "cloud"] });

    await expect(repository.updateTicket("user_123", "repo", created.id, {
      baseRevision: 1,
      patch: { status: "Done" },
    })).resolves.toBeNull();
  });

  it("keeps one active ticket per project/source identity", async () => {
    const first = await repository.upsertExternalTicket("user_123", "repo", {
      sourceKind: "linear",
      sourceId: "issue_123",
      identifier: "LIN-123",
      title: "Original title",
      description: "",
      status: "Todo",
      priority: "medium",
      assigneeIds: [],
      labelIds: ["symphony"],
      dependencyIds: [],
      artifactIds: [],
      sourceUrl: "https://linear.app/acme/issue/LIN-123",
    });

    const second = await repository.upsertExternalTicket("user_123", "repo", {
      ...first,
      sourceId: "issue_123",
      title: "Synced title",
      status: "Ready",
    });

    const listed = await repository.listTickets("user_123", "repo", { source: "all", limit: 20 });
    expect(listed.tickets).toHaveLength(1);
    expect(second).toMatchObject({ id: first.id, title: "Synced title", status: "Ready", revision: 2 });
  });
});
