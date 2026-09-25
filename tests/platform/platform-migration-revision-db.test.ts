import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it } from "vitest";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";

describe("versioned platform migration transaction", () => {
  it("skips completed DDL and leaves the old revision after a failed upgrade", async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<Record<string, never>>({ dialect: instance.dialect });
    try {
      await runPlatformMigration(db, async (trx) => {
        await sql`CREATE TABLE migration_probe (id TEXT PRIMARY KEY)`.execute(trx);
      }, { revision: { generation: 1, fingerprint: "first" } });

      // A second startup would fail if it repeated the non-idempotent DDL.
      await expect(runPlatformMigration(db, async (trx) => {
        await sql`CREATE TABLE migration_probe (id TEXT PRIMARY KEY)`.execute(trx);
      }, { revision: { generation: 1, fingerprint: "first" } })).resolves.toBeUndefined();

      await expect(runPlatformMigration(db, async (trx) => {
        await sql`CREATE TABLE failed_upgrade (id TEXT PRIMARY KEY)`.execute(trx);
        throw new Error("migration failure");
      }, { revision: { generation: 2, fingerprint: "second" } })).rejects.toThrow("migration failure");

      const applied = await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
      `.execute(db);
      expect(applied.rows[0]).toMatchObject({ generation: 1, fingerprint: "first" });
      const failedTable = await sql<{ name: string | null }>`
        SELECT to_regclass('failed_upgrade')::text AS name
      `.execute(db);
      expect(failedTable.rows[0]?.name).toBeNull();

      await runPlatformMigration(db, async () => { throw new Error("old migration should skip"); }, {
        revision: { generation: 1, fingerprint: "first" },
      });

      await runPlatformMigration(db, async (trx) => {
        await sql`CREATE TABLE upgraded_probe (id TEXT PRIMARY KEY)`.execute(trx);
      }, { revision: { generation: 2, fingerprint: "second" } });
      await runPlatformMigration(db, async () => { throw new Error("rolled-back instance should skip"); }, {
        revision: { generation: 1, fingerprint: "first" },
      });
      const newest = await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
      `.execute(db);
      expect(newest.rows[0]).toMatchObject({ generation: 2, fingerprint: "second" });
    } finally { await db.destroy(); }
  });
});
