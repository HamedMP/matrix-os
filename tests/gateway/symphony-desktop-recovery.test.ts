import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { KyselySymphonyRepository } from "../../packages/gateway/src/symphony/repository.js";

describe("Symphony desktop recovery", () => {
  let instance: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<any>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = new Kysely<any>({ dialect: instance.dialect });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("restores unified ticket source metadata after repository restart", async () => {
    const first = new KyselySymphonyRepository(db);
    await first.bootstrap();
    await first.upsertRun("user_123", {
      id: "run_matrix",
      installationId: "sym_user_123",
      ticketExternalId: "ticket_123",
      ticketIdentifier: "MAT-123",
      ticketTitle: "Internal ticket",
      ticketSourceKind: "matrix",
      trackedTicketId: "ticket_123",
      status: "running",
      attempt: 1,
      agent: "codex",
      projectSlug: "repo",
      claimKey: "matrix:ticket_123",
      lastEvent: "Agent session started",
      updatedAt: "2026-05-14T18:00:00.000Z",
    });

    const restarted = new KyselySymphonyRepository(db);
    await restarted.bootstrap();

    await expect(restarted.findActiveRunByClaim("user_123", "matrix:ticket_123")).resolves.toMatchObject({
      ticketSourceKind: "matrix",
      trackedTicketId: "ticket_123",
    });
  });
});
