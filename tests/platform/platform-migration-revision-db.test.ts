import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it } from "vitest";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import type { PlatformDatabase } from "../../packages/platform/src/db.js";
import { PLATFORM_MIGRATION_STEPS } from "../../packages/platform/src/database/migrate.js";
import { PLATFORM_SCHEMA_REVISION } from "../../packages/platform/src/database/migration-revision.js";
import { runPlatformStartupMigrations } from "../../packages/platform/src/database/run-migrations.js";

describe("versioned platform migration transaction", () => {
  it.each([
    { generation: 14, fingerprint: "d5f4cba6cafb18bf74fa30cc097032f8c9ae7ac83bcead2aaf70b7252d207ef4" },
    { generation: 15, fingerprint: "c8ae79e3d365a70548fba1de45bf84b58d259e43bd0a255c2d2476bc564e4950" },
  ])("upgrades deployed core generation $generation without resetting its marker or owner data", async (previous) => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<PlatformDatabase>({ dialect: instance.dialect });
    try {
      await runPlatformMigration(db, async (trx) => {
        // Model a predecessor that has no Preview Drive grants yet, including
        // unrelated additive data that a newer startup must leave intact.
        for (const step of PLATFORM_MIGRATION_STEPS) {
          if (step.name !== "preview-drive") await step.run(trx);
        }
        await sql`ALTER TABLE user_machines ADD COLUMN retained_extension TEXT NOT NULL DEFAULT 'retained'`.execute(trx);
        await sql`INSERT INTO user_machines (machine_id, clerk_user_id, handle, provisioned_at)
          VALUES ('retained-machine', 'retained-owner', 'retained-owner', '2026-10-01')`.execute(trx);
      }, { revision: previous });

      // A same-generation fingerprint collision still fails closed, without
      // executing DDL or changing the stored predecessor.
      await expect(runPlatformMigration(db, async (trx) => {
        await sql`CREATE TABLE forbidden_revision_probe (id TEXT PRIMARY KEY)`.execute(trx);
      }, { revision: { generation: previous.generation, fingerprint: PLATFORM_SCHEMA_REVISION.fingerprint } }))
        .rejects.toThrow("Conflicting platform schema fingerprints");
      expect((await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
      `.execute(db)).rows).toEqual([previous]);
      expect((await sql<{ name: string | null }>`
        SELECT to_regclass('forbidden_revision_probe')::text AS name
      `.execute(db)).rows[0]?.name).toBeNull();

      await runPlatformStartupMigrations(db);
      expect((await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
      `.execute(db)).rows).toEqual([PLATFORM_SCHEMA_REVISION]);
      expect((await sql<{ owner: string; retained_extension: string }>`
        SELECT clerk_user_id AS owner, retained_extension FROM user_machines WHERE machine_id = 'retained-machine'
      `.execute(db)).rows).toEqual([{ owner: "retained-owner", retained_extension: "retained" }]);
      expect((await sql<{ name: string | null }>`
        SELECT to_regclass('preview_drive_grants')::text AS name
      `.execute(db)).rows[0]?.name).toBe("preview_drive_grants");

      // Older overlapping instances cannot regress the marker; the next new
      // startup also succeeds with the completed generation.
      await runPlatformMigration(db, async () => { throw new Error("older startup must skip"); }, { revision: previous });
      await runPlatformStartupMigrations(db);
      expect((await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
      `.execute(db)).rows).toEqual([PLATFORM_SCHEMA_REVISION]);
    } finally { await db.destroy(); }
  });
  it('rolls back a failed channel migration independently of a newer core marker', async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<Record<string, never>>({ dialect: instance.dialect });
    try {
      await runPlatformMigration(db, async () => undefined, { revision: { generation: 8, fingerprint: 'newer-core' } });
      const options = { scope: 'whatsapp' as const, revision: { generation: 1, fingerprint: 'channel' } };
      await expect(runPlatformMigration(db, async trx => {
        await sql`CREATE TABLE channel_probe(id TEXT PRIMARY KEY)`.execute(trx);
        throw new Error('channel failure');
      }, options)).rejects.toThrow('channel failure');
      expect((await sql<{ name: string | null }>`SELECT to_regclass('channel_probe')::text AS name`.execute(db)).rows[0]?.name).toBeNull();
      expect((await sql`SELECT scope FROM platform_schema_revisions WHERE scope='whatsapp'`.execute(db)).rows).toEqual([]);
      await runPlatformMigration(db, async trx => { await sql`CREATE TABLE channel_probe(id TEXT PRIMARY KEY)`.execute(trx); }, options);
      await runPlatformMigration(db, async () => { throw new Error('completed channel must skip'); }, options);
      expect((await sql<{ scope: string; generation: number }>`SELECT scope,generation FROM platform_schema_revisions ORDER BY scope`.execute(db)).rows)
        .toEqual([{ scope: 'core', generation: 8 }, { scope: 'whatsapp', generation: 1 }]);
    } finally { await db.destroy(); }
  });
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
