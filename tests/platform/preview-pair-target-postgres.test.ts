import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";
import { createIsolatedPreviewPairDatabase } from "./preview-pair-isolated-postgres.js";
import { createPreviewPairTargetDatabase, assertPreviewPairTargetPrepared } from "../../packages/platform/src/preview-pair/target-database.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("source-owned target connection opens without migrations", () => {
  let source: Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
  let target: Awaited<ReturnType<typeof createIsolatedPreviewPairDatabase>>;
  beforeEach(async () => {
    source = await createPreviewPairPostgresFixture();
    try { target = await createIsolatedPreviewPairDatabase(); }
    catch (error: unknown) { await source.destroy(); throw error; }
  }, 30_000);
  afterEach(async () => { try { await target?.destroy(); } finally { await source?.destroy(); } });
  it("opens a verified separate role/database and closes only its owned pool", async () => {
    const dormant = createPreviewPairTargetDatabase(target.databaseUrl);
    await dormant.destroy();
    await expect(sql`SELECT 1`.execute(dormant.executor)).rejects.toThrow();
    const opened = createPreviewPairTargetDatabase(target.databaseUrl);
    try {
      await assertPreviewPairTargetPrepared(source.db, opened);
      expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM user_machines`.execute(opened.executor)).rows[0].count).toBe(0);
    } finally { await opened.destroy(); }
    await expect(sql`SELECT 1`.execute(opened.executor)).rejects.toThrow();
    expect((await sql<{ n: number }>`SELECT 1 AS n`.execute(target.db.executor)).rows[0].n).toBe(1);
    expect((await sql<{ n: number }>`SELECT 1 AS n`.execute(source.db.executor)).rows[0].n).toBe(1);
  });
  it("does not bootstrap an unprepared schema before verifying target isolation", async () => {
    const schema = `eng418_empty_${randomUUID().replaceAll("-", "")}`;
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(target.db.executor);
    try {
      const url = new URL(target.databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`);
      const opened = createPreviewPairTargetDatabase(url.toString());
      try { await expect(assertPreviewPairTargetPrepared(source.db, opened)).rejects.toThrow("unavailable"); }
      finally { await opened.destroy(); }
      const tables = await sql<{ tablename: string }>`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = ${schema}`.execute(target.db.executor);
      expect(tables.rows).toEqual([]);
    } finally { await sql`DROP SCHEMA ${sql.id(schema)}`.execute(target.db.executor); }
  });
});
