/** Brain store per-scope capacity limits and shared Kysely ownership. */
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it } from "vitest";
import { BrainRepository, type BrainDatabase } from "../../packages/gateway/src/brain/index.js";
import {
  brainDocumentId,
  createBrainHarness,
  expectBrainError,
  manualDocument,
  scopeA,
  scopeB,
} from "./helpers/brain-store-helpers.js";

describe("brain store capacity", () => {
  it("caps document count per scope, counting tombstones until erased", async () => {
    const harness = await createBrainHarness({ maxDocumentsPerScope: 2 });
    const { repository } = harness;
    try {
      await repository.upsertDocument(scopeA, manualDocument("a"));
      await repository.upsertDocument(scopeA, manualDocument("b"));
      await expectBrainError(repository.upsertDocument(scopeA, manualDocument("c")), "capacity");
      await repository.deleteDocument(scopeA, { documentId: brainDocumentId("a") });
      await expectBrainError(repository.upsertDocument(scopeA, manualDocument("c")), "capacity");
      expect((await repository.upsertDocument(scopeA, manualDocument("a"))).outcome).toBe("created");
      expect((await repository.upsertDocument(scopeB, manualDocument("c"))).outcome).toBe("created");
      await repository.eraseScope(scopeA);
      expect((await repository.upsertDocument(scopeA, manualDocument("c"))).outcome).toBe("created");
    } finally {
      await harness.destroy();
    }
  });

  it("caps live bytes per scope and frees them on delete", async () => {
    const harness = await createBrainHarness({ maxBytesPerScope: 40 });
    const { repository } = harness;
    try {
      await repository.upsertDocument(scopeA, manualDocument("a"));
      await repository.upsertDocument(scopeA, manualDocument("b"));
      await expectBrainError(repository.upsertDocument(scopeA, manualDocument("c")), "capacity");
      await expectBrainError(repository.upsertDocument(scopeA, manualDocument("a", { body: "Body for a plus more" })), "capacity");
      await expectBrainError(
        repository.reviseDocument(scopeA, { documentId: brainDocumentId("a"), expectedRevision: 1, body: "Body for a plus more" }),
        "capacity",
      );
      await repository.deleteDocument(scopeA, { documentId: brainDocumentId("b") });
      expect((await repository.upsertDocument(scopeA, manualDocument("c"))).outcome).toBe("created");
      expect((await repository.upsertDocument(scopeB, manualDocument("c"))).outcome).toBe("created");
    } finally {
      await harness.destroy();
    }
  });

  it("clamps out-of-range limits to the configured ceilings", async () => {
    const harness = await createBrainHarness({ maxDocumentsPerScope: 0, maxBytesPerScope: Number.NaN });
    try {
      await harness.repository.upsertDocument(scopeA, manualDocument("a"));
      await expectBrainError(harness.repository.upsertDocument(scopeA, manualDocument("b")), "capacity");
    } finally {
      await harness.destroy();
    }
  });

  it("honours a byte budget above the default while still capping document count", async () => {
    const harness = await createBrainHarness({ maxBytesPerScope: 1_000_000_000, maxDocumentsPerScope: 1_000_000 });
    try {
      // The resolved limits are private; reading them pins the clamp without writing 256 MiB of rows.
      const { limits } = harness.repository as unknown as { limits: { maxDocumentsPerScope: number; maxBytesPerScope: number } };
      expect(limits).toEqual({ maxDocumentsPerScope: 100_000, maxBytesPerScope: 1_000_000_000 });
    } finally {
      await harness.destroy();
    }
  });
});

describe("brain store connection ownership", () => {
  it("does not destroy a shared Kysely instance", async () => {
    const pglite = await KyselyPGlite.create();
    const shared = new Kysely<BrainDatabase>({ dialect: pglite.dialect });
    const repository = new BrainRepository(shared);
    await repository.bootstrap();
    expect(repository.kysely).toBe(shared);
    const before = Date.now();
    const { source } = await repository.createSource(scopeA, { kind: "manual", externalRef: "clock", label: "Clock" });
    expect(Date.parse(source.createdAt)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(source.createdAt)).toBeLessThanOrEqual(Date.now() + 1_000);
    await repository.destroy();
    const probe = await sql<{ one: number }>`SELECT 1 AS one`.execute(shared);
    expect(probe.rows).toEqual([{ one: 1 }]);
    await shared.destroy();
  });
});
