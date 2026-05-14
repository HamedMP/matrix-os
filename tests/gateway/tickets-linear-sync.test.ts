import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { KyselyTicketRepository } from "../../packages/gateway/src/tickets/internal-repository.js";
import { syncLinearTickets } from "../../packages/gateway/src/tickets/linear-sync.js";
import { createTicketPage } from "./tickets-fixtures.js";

describe("Linear ticket sync", () => {
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

  it("syncs 100 Linear tickets without duplicating source identities", async () => {
    const page = createTicketPage(100, { projectSlug: "repo", sourceKind: "linear" });

    await expect(syncLinearTickets(repository, {
      ownerId: "user_123",
      projectSlug: "repo",
      sourceId: "linear_main",
      tickets: page,
      truncated: false,
    })).resolves.toMatchObject({ created: 100, updated: 0, unchanged: 0, truncated: false });

    await expect(syncLinearTickets(repository, {
      ownerId: "user_123",
      projectSlug: "repo",
      sourceId: "linear_main",
      tickets: page,
      truncated: false,
    })).resolves.toMatchObject({ created: 0, updated: 0, unchanged: 100 });

    const listed = await repository.listTickets("user_123", "repo", { source: "linear", limit: 120 });
    expect(listed.tickets).toHaveLength(100);
    expect(new Set(listed.tickets.map((ticket) => ticket.sourceId)).size).toBe(100);
  });
});
