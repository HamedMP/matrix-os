import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import { migratePlatformSchema } from '../../packages/platform/src/database/migrate.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;

interface Target {
  open(): Promise<PlatformDB>;
  close(db: PlatformDB): Promise<void>;
}

const pgliteTarget: Target = {
  async open() {
    return (await createTestPlatformDb()).db;
  },
  async close(db) {
    await destroyTestPlatformDb(db);
  },
};

function postgresTarget(url: string): Target {
  const schemas = new Map<PlatformDB, { admin: pg.Pool; schema: string }>();
  return {
    async open() {
      const schema = `metal_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`);
      const db = createPlatformDb(scoped.toString());
      await db.ready;
      schemas.set(db, { admin, schema });
      return db;
    },
    async close(db) {
      const entry = schemas.get(db);
      schemas.delete(db);
      await db.destroy();
      if (entry) {
        await entry.admin.query(`DROP SCHEMA "${entry.schema}" CASCADE`);
        await entry.admin.end();
      }
    },
  };
}

const targets: Array<[string, Target | null]> = [
  ['PGlite', pgliteTarget],
  ['Postgres', databaseUrl ? postgresTarget(databaseUrl) : null],
];

/** Metal-related schema shape: the host table, the two machine columns, and their constraints and indexes. */
async function captureMetalSchema(db: PlatformDB) {
  const x = db.executor;
  const columns = (await sql<Record<string, unknown>>`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = current_schema()
      and (table_name = 'metal_hosts' or (table_name = 'user_machines' and column_name in ('metal_host_id', 'metal_vm_id', 'substrate')))
    order by table_name, column_name
  `.execute(x)).rows;
  const constraints = (await sql<Record<string, unknown>>`
    select c.conrelid::regclass::text as table_name, c.conname as name, pg_get_constraintdef(c.oid) as definition
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = current_schema()
      and (c.conrelid::regclass::text = 'metal_hosts'
        or c.conname in ('user_machines_substrate_check', 'user_machines_metal_host_check', 'user_machines_metal_host_id_fkey'))
    order by 1, 2
  `.execute(x)).rows;
  const indexes = (await sql<Record<string, unknown>>`
    select tablename as table_name, indexname as name, indexdef as definition
    from pg_indexes
    where schemaname = current_schema() and (tablename = 'metal_hosts' or indexname like '%metal%')
    order by 1, 2
  `.execute(x)).rows;
  return { columns, constraints, indexes };
}

async function insertHost(db: PlatformDB, id: string, status = 'active'): Promise<void> {
  await sql`
    INSERT INTO metal_hosts (id, name, api_url, ingress_host, status, memory_capacity_mib, admission_ceiling_mib)
    VALUES (${id}, ${`host-${id}`}, 'https://hostd.example.test:9443', 'metal.example.test:9443', ${status}, 65536, 57344)
  `.execute(db.kysely);
}

async function insertMachine(db: PlatformDB, values: {
  machineId: string;
  substrate: string;
  metalHostId?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO user_machines (machine_id, clerk_user_id, handle, provisioned_at, substrate, metal_host_id)
    VALUES (${values.machineId}, ${`user_${values.machineId}`}, ${values.machineId},
      '2026-11-01T00:00:00.000Z', ${values.substrate}, ${values.metalHostId ?? null})
  `.execute(db.kysely);
}

/** Return a migrated database to the generation-26 shape: no host table, no metal columns, vps/container only. */
async function downgradeToPreMetal(db: PlatformDB): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_user_machines_metal_host`.execute(db.kysely);
  await sql`ALTER TABLE user_machines DROP CONSTRAINT IF EXISTS user_machines_metal_host_check`.execute(db.kysely);
  await sql`ALTER TABLE user_machines DROP COLUMN IF EXISTS metal_host_id, DROP COLUMN IF EXISTS metal_vm_id`.execute(db.kysely);
  await sql`DROP TABLE IF EXISTS metal_hosts`.execute(db.kysely);
  await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_substrate_check`.execute(db.kysely);
  await sql`
    ALTER TABLE user_machines ADD CONSTRAINT user_machines_substrate_check CHECK (substrate IN ('vps', 'container'))
  `.execute(db.kysely);
}

for (const [label, target] of targets) {
  describe.skipIf(!target)(`metal hosts migration on ${label}`, () => {
    let db: PlatformDB;

    beforeEach(async () => {
      db = await target!.open();
    });

    afterEach(async () => {
      await target!.close(db);
    });

    it('migration is idempotent on PGlite and on Postgres', async () => {
      const fresh = await captureMetalSchema(db);
      expect(fresh.constraints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'user_machines_substrate_check',
          definition: "CHECK ((substrate = ANY (ARRAY['vps'::text, 'container'::text, 'metal'::text])))",
        }),
        expect.objectContaining({
          name: 'user_machines_metal_host_check',
          definition: "CHECK (((substrate <> 'metal'::text) OR (metal_host_id IS NOT NULL)))",
        }),
        expect.objectContaining({
          name: 'user_machines_metal_host_id_fkey',
          definition: 'FOREIGN KEY (metal_host_id) REFERENCES metal_hosts(id)',
        }),
      ]));

      await migratePlatformSchema(db.executor);
      await migratePlatformSchema(db.executor);
      expect(await captureMetalSchema(db)).toEqual(fresh);

      // A database migrated before the metal kind existed converges on the fresh shape.
      await downgradeToPreMetal(db);
      await migratePlatformSchema(db.executor);
      await migratePlatformSchema(db.executor);
      expect(await captureMetalSchema(db)).toEqual(fresh);
    });

    it('rejects a metal machine without a host', async () => {
      await expect(insertMachine(db, { machineId: 'm-no-host', substrate: 'metal' }))
        .rejects.toThrow(/user_machines_metal_host_check/);
      await expect(insertMachine(db, { machineId: 'm-ghost', substrate: 'metal', metalHostId: 'missing-host' }))
        .rejects.toThrow(/user_machines_metal_host_id_fkey/);

      await insertHost(db, 'h1');
      await insertMachine(db, { machineId: 'm-ok', substrate: 'metal', metalHostId: 'h1' });
      await expect(sql`UPDATE user_machines SET metal_host_id = NULL WHERE machine_id = 'm-ok'`.execute(db.kysely))
        .rejects.toThrow(/user_machines_metal_host_check/);
      await expect(sql`DELETE FROM metal_hosts WHERE id = 'h1'`.execute(db.kysely))
        .rejects.toThrow(/user_machines_metal_host_id_fkey/);
      await expect(insertMachine(db, { machineId: 'm-bad', substrate: 'lambda' }))
        .rejects.toThrow(/user_machines_substrate_check/);
    });

    it('existing vps rows are unchanged', async () => {
      await downgradeToPreMetal(db);
      await sql`
        INSERT INTO user_machines (machine_id, clerk_user_id, handle, status, public_ipv4, provisioned_at)
        VALUES ('legacy-vps', 'user_legacy', 'legacy', 'running', '203.0.113.7', '2026-10-01T00:00:00.000Z')
      `.execute(db.kysely);
      const before = (await sql<Record<string, unknown>>`SELECT * FROM user_machines WHERE machine_id = 'legacy-vps'`
        .execute(db.kysely)).rows[0]!;

      await migratePlatformSchema(db.executor);

      const after = (await sql<Record<string, unknown>>`SELECT * FROM user_machines WHERE machine_id = 'legacy-vps'`
        .execute(db.kysely)).rows[0]!;
      const { metal_host_id, metal_vm_id, ...rest } = after;
      expect(rest).toEqual(before);
      expect({ metal_host_id, metal_vm_id }).toEqual({ metal_host_id: null, metal_vm_id: null });
      expect(after.substrate).toBe('vps');
    });
  });
}
