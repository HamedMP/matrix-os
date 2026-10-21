import { readFile } from "node:fs/promises";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it } from "vitest";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import type { PlatformDatabase } from "../../packages/platform/src/db.js";
import { createRealPlatformCollaborationTestDatabase } from "./collaboration-test-support.js";
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
  it('upgrades deployed generation 16 grants additively and retains old nonce rows', async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<PlatformDatabase>({ dialect: instance.dialect });
    const deployed = { generation: 16, fingerprint: "0b59a8e8db015a737cdc59eba7a191b34a7bcef54f5dfae48f05390d0f20cf70" };
    try {
      await runPlatformMigration(db, async trx => {
        for (const step of PLATFORM_MIGRATION_STEPS) if (step.name !== 'preview-drive') await step.run(trx);
        // Frozen deployed generation 16 schema, before immutable account bindings.
        await sql`
    CREATE TABLE IF NOT EXISTS preview_drive_grants (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('run', 'action')),
      proof_nonce_hash TEXT NOT NULL UNIQUE,
      run_token_hash TEXT,
      handle TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      body_digest TEXT NOT NULL,
      action_digest TEXT,
      account_label TEXT,
      max_results INTEGER,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `.execute(trx);
        await sql`INSERT INTO preview_drive_grants
          (token_hash, kind, proof_nonce_hash, handle, actor_id, chat_id, turn_id, run_id, client_request_id, body_digest, expires_at, consumed_at)
          VALUES ('retained-token', 'run', 'retained-nonce', 'pr-1234', 'retained-owner', 'chat-one', 'turn-one', 'run-one', 'request-one', 'digest', '2026-10-09T01:00:00Z', '2026-10-09T00:00:00Z')`.execute(trx);
      }, { revision: deployed });
      const before = (await sql`SELECT * FROM preview_drive_grants`.execute(db)).rows;
      await runPlatformStartupMigrations(db);
      expect((await sql`SELECT * FROM preview_drive_grants`.execute(db)).rows)
        .toEqual(before.map(row => ({ ...row, connection_id: null, provider_account_id: null })));
      expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope='core'`.execute(db)).rows)
        .toEqual([PLATFORM_SCHEMA_REVISION]);
      expect(PLATFORM_SCHEMA_REVISION.generation).toBeGreaterThan(deployed.generation);
      await runPlatformMigration(db, async () => { throw new Error('old startup must skip'); }, { revision: deployed });
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


it.each([false, ...(process.env.MATRIX_TEST_POSTGRES_URL ? [true] : [])])("upgrades main generation 18 into the additive Preview union (PostgreSQL=%s)", async postgres => {
  const real = postgres ? await createRealPlatformCollaborationTestDatabase() : undefined;
  const local = real ? undefined : await KyselyPGlite.create();
  const db = real ? real.collaborationDb as unknown as Kysely<PlatformDatabase>
    : new Kysely<PlatformDatabase>({ dialect: local!.dialect });
  const predecessor = { generation: 18, fingerprint: "b8ba2189f225ff198db182d66a2e413617e0d62771ce482253c1243099160c41" };
  try {
    await runPlatformMigration(db, async trx => {
      for (const step of PLATFORM_MIGRATION_STEPS) if (step.name !== "preview-drive") await step.run(trx);
      await sql`ALTER TABLE user_machines ADD COLUMN retained_union_fixture TEXT DEFAULT 'retained'`.execute(trx);
      await sql`INSERT INTO user_machines (machine_id, clerk_user_id, handle, provisioned_at)
        VALUES ('union-fixture', 'union-owner', 'union-owner', '2026-10-09')`.execute(trx);
      await sql`INSERT INTO ai_funded_runtime_balances
        (machine_id, owner_id, runtime_slot, credit_balance_microusd, month_period_start, updated_at)
        VALUES ('union-fixture','union-owner','primary',123456,'2026-10-01','2026-10-09')`.execute(trx);
    }, { revision: predecessor });
    const before = (await sql`SELECT * FROM ai_funded_runtime_balances`.execute(db)).rows;
    expect((await sql<{ name: string | null }>`SELECT to_regclass('preview_drive_grants')::text AS name`.execute(db)).rows[0].name).toBeNull();
    await runPlatformStartupMigrations(db);
    expect((await sql`SELECT generation,fingerprint FROM platform_schema_revisions WHERE scope='core'`.execute(db)).rows).toEqual([PLATFORM_SCHEMA_REVISION]);
    expect(PLATFORM_SCHEMA_REVISION.generation).toBeGreaterThan(predecessor.generation);
    expect((await sql`SELECT * FROM ai_funded_runtime_balances`.execute(db)).rows).toEqual(before);
    expect((await sql`SELECT retained_union_fixture FROM user_machines`.execute(db)).rows).toEqual([{ retained_union_fixture: "retained" }]);
    expect((await sql<{ name: string | null }>`SELECT to_regclass('preview_drive_grants')::text AS name`.execute(db)).rows[0].name).not.toBeNull();
    expect((await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='preview_drive_grants'`.execute(db)).rows.map(row => row.column_name))
      .toEqual(expect.arrayContaining(["connection_id", "provider_account_id"]));
    expect((await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema()
      AND indexname='idx_ai_funded_unknown_waiver_owner'`.execute(db)).rows[0].indexdef).toContain('charge_waiver');
    if (postgres) {
      const baseline = JSON.parse(await readFile(new URL("./fixtures/platform-schema-baseline.json", import.meta.url), "utf8"));
      const columns = (await sql`SELECT table_name,column_name,data_type,is_nullable,column_default,
        character_maximum_length,numeric_precision,numeric_scale FROM information_schema.columns
        WHERE table_schema=current_schema() AND column_name <> 'retained_union_fixture'
        ORDER BY table_name,ordinal_position`.execute(db)).rows;
      expect(columns).toEqual(baseline.columns);
      const names = (await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() ORDER BY table_name`.execute(db)).rows.map(row => row.table_name);
      expect(names).toEqual(baseline.tables);
      const indexes = (await sql<{ table_name: string; name: string; definition: string }>`
        SELECT tablename AS table_name,indexname AS name,replace(indexdef,current_schema() || '.', 'public.') AS definition
        FROM pg_indexes WHERE schemaname=current_schema() ORDER BY tablename,indexname`.execute(db)).rows;
      expect(indexes).toEqual(baseline.indexes);
      const constraints = (await sql`SELECT c.conrelid::regclass::text AS table_name,c.conname AS name,
        c.contype AS type,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
        JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=current_schema() ORDER BY 1,2`.execute(db)).rows;
      expect(constraints).toEqual(baseline.constraints);
    }
    const old = async () => { throw new Error("older main must skip DDL"); };
    await runPlatformMigration(db, old, { revision: predecessor });
    await runPlatformStartupMigrations(db);
    expect((await sql`SELECT * FROM ai_funded_runtime_balances`.execute(db)).rows).toEqual(before);
  } finally {
    if (real) await real.destroy();
    else await db.destroy();
  }
});
