import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("pair qualification uses independent PostgreSQL connections", () => {
  let fixture: Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
  beforeAll(async () => { fixture = await createPreviewPairPostgresFixture(); }, 30_000);
  afterAll(async () => { await fixture?.destroy(); });
  it("holds two simultaneous real connections with the actual Platform startup schema", async () => {
    const first = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const holding = fixture.db.transaction(async trx => {
      first.resolve((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx.executor)).rows[0]!.pid);
      await release.promise;
    });
    try {
      const pid = await first.promise;
      const second = await fixture.db.transaction(async trx => (await sql<{ pid: number; count: string }>`
        SELECT pg_backend_pid() AS pid, (SELECT count(*) FROM preview_pairs) AS count`.execute(trx.executor)).rows[0]!);
      expect(second.pid).not.toBe(pid);
      expect(Number(second.count)).toBe(0);
    } finally { release.resolve(); await holding; }
  });
});
