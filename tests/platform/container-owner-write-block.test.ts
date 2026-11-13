import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import {
  createPgOwnerClusterAdmin,
  type PgOwnerClusterAdmin,
} from '../../packages/platform/src/substrates/container-owner-cluster-admin.js';
import {
  createContainerOwnerDatabases,
  type ContainerOwnerDatabases,
  type OwnerDatabaseCredentials,
} from '../../packages/platform/src/substrates/container-owner-database.js';
import { createScopedPlatformDbs, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const SECRET = 's'.repeat(48);
const signal = () => AbortSignal.timeout(30_000);
const realUrl = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!realUrl)('owner database write block on a real PostgreSQL server with a non-superuser admin', () => {
  let db: PlatformDB;
  let superuser: pg.Pool;
  let adminRole: string;
  let admin: PgOwnerClusterAdmin;
  let scoped: ScopedPlatformDbs;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    superuser = new pg.Pool({ connectionString: realUrl, max: 2 });
    adminRole = `mx_block_admin_${randomUUID().slice(0, 8)}`;
    await superuser.query(`CREATE ROLE ${adminRole} LOGIN PASSWORD 'block-admin' NOSUPERUSER CREATEROLE CREATEDB`);
    await superuser.query(`GRANT pg_signal_backend TO ${adminRole}`);
    const url = new URL(realUrl!);
    url.username = adminRole;
    url.password = 'block-admin';
    admin = createPgOwnerClusterAdmin({ connectionString: url.toString() });
    scoped = await createScopedPlatformDbs('write_block', 1);
  });
  afterAll(async () => {
    await admin?.close();
    await scoped?.close();
    await superuser.query(`DROP ROLE IF EXISTS ${adminRole}`);
    await superuser.end();
  });
  beforeEach(async () => { [db] = scoped.pools as [PlatformDB]; });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  function connect(credentials: { databaseName: string; roleName?: string; password?: string }): pg.Client {
    const url = new URL(realUrl!);
    if (credentials.roleName) url.username = credentials.roleName;
    if (credentials.password) url.password = credentials.password;
    url.pathname = `/${credentials.databaseName}`;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on('error', () => undefined);
    return client;
  }

  async function inDatabase<T>(
    credentials: { databaseName: string; roleName?: string; password?: string },
    work: (client: pg.Client) => Promise<T>,
  ): Promise<T> {
    const client = connect(credentials);
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  /** An owner whose limit is one byte, so every enforcement blocks until the limit is raised. */
  async function owner(setup: string[]): Promise<{ id: string; credentials: OwnerDatabaseCredentials; service: ContainerOwnerDatabases }> {
    const id = `user_block_${randomUUID().slice(0, 8)}`;
    const service = createContainerOwnerDatabases({ db, admin, passwordSecret: SECRET, sizeLimitBytes: 1 });
    cleanups.push(() => service.remove(id, signal()));
    const credentials = await service.ensure(id, 1, signal());
    await inDatabase(credentials, async (client) => {
      for (const statement of setup) await client.query(statement);
    });
    return { id, credentials, service };
  }

  async function raiseLimit(id: string): Promise<void> {
    await db.executor.updateTable('container_owner_databases').set({ size_limit_bytes: 1024 ** 4 })
      .where('clerk_user_id', '=', id).execute();
  }

  it('re-applies exactly the allowed privileges on every block application', async () => {
    const { id, credentials, service } = await owner([
      'CREATE SCHEMA app',
      'CREATE TABLE app.items (id int, body text)',
      'CREATE VIEW app.item_view AS SELECT id FROM app.items',
      'CREATE SEQUENCE app.counter',
      'CREATE FUNCTION app.plain() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      'CREATE FUNCTION app.definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 2 $$',
    ]);
    expect(await service.enforceSizeLimit(id, signal())).toMatchObject({ writesBlocked: true });
    const role = credentials.roleName;
    await inDatabase({ databaseName: credentials.databaseName }, async (client) => {
      for (const grantee of [`"${role}"`, 'PUBLIC']) {
        await client.query(`GRANT INSERT, UPDATE, REFERENCES, TRIGGER ON app.items TO ${grantee}`);
        await client.query(`GRANT UPDATE (body) ON app.items TO ${grantee}`);
        await client.query(`GRANT INSERT, UPDATE ON app.item_view TO ${grantee}`);
        await client.query(`GRANT USAGE, UPDATE ON SEQUENCE app.counter TO ${grantee}`);
        await client.query(`GRANT CREATE ON SCHEMA app TO ${grantee}`);
        await client.query(`GRANT EXECUTE ON FUNCTION app.definer() TO ${grantee}`);
      }
    });

    expect(await service.enforceSizeLimit(id, signal())).toMatchObject({ writesBlocked: true });

    const privileges = await inDatabase({ databaseName: credentials.databaseName }, async (client) => (await client.query(`SELECT
        has_table_privilege($1, 'app.items', 'SELECT') AS items_select,
        has_table_privilege($1, 'app.items', 'DELETE') AS items_delete,
        has_table_privilege($1, 'app.items', 'TRUNCATE') AS items_truncate,
        has_table_privilege($1, 'app.items', 'INSERT') AS items_insert,
        has_table_privilege($1, 'app.items', 'UPDATE') AS items_update,
        has_table_privilege($1, 'app.items', 'REFERENCES') AS items_references,
        has_table_privilege($1, 'app.items', 'TRIGGER') AS items_trigger,
        has_any_column_privilege($1, 'app.items', 'UPDATE') AS items_column_update,
        has_table_privilege($1, 'app.item_view', 'SELECT') AS view_select,
        has_table_privilege($1, 'app.item_view', 'INSERT') AS view_insert,
        has_sequence_privilege($1, 'app.counter', 'SELECT') AS sequence_select,
        has_sequence_privilege($1, 'app.counter', 'USAGE') AS sequence_usage,
        has_sequence_privilege($1, 'app.counter', 'UPDATE') AS sequence_update,
        has_schema_privilege($1, 'app', 'USAGE') AS schema_usage,
        has_schema_privilege($1, 'app', 'CREATE') AS schema_create,
        has_function_privilege($1, 'app.plain()', 'EXECUTE') AS plain_execute,
        has_function_privilege($1, 'app.definer()', 'EXECUTE') AS definer_execute`, [role])).rows[0]);
    expect(privileges).toEqual({
      items_select: true, items_delete: true, items_truncate: true,
      items_insert: false, items_update: false, items_references: false, items_trigger: false, items_column_update: false,
      view_select: true, view_insert: false,
      sequence_select: true, sequence_usage: false, sequence_update: false,
      schema_usage: true, schema_create: false,
      plain_execute: true, definer_execute: false,
    });

    const publicEntries = await inDatabase({ databaseName: credentials.databaseName }, async (client) => (await client.query(`
      SELECT 'relation' AS kind, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relnamespace = 'app'::regnamespace AND a.grantee = 0
      UNION ALL SELECT 'column', a.privilege_type FROM pg_attribute t, aclexplode(t.attacl) a
        WHERE t.attrelid = 'app.items'::regclass AND a.grantee = 0
      UNION ALL SELECT 'schema', a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE n.nspname = 'app' AND a.grantee = 0
      UNION ALL SELECT 'function', a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.pronamespace = 'app'::regnamespace AND a.grantee = 0`)).rows);
    expect(publicEntries).toEqual([]);

    await inDatabase({ ...credentials }, async (client) => {
      await client.query('SET default_transaction_read_only = off');
      await expect(client.query('INSERT INTO app.items VALUES (1)')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(`SELECT nextval('app.counter')`)).rejects.toMatchObject({ code: '42501' });
      expect((await client.query('SELECT app.plain() AS n')).rows).toEqual([{ n: 1 }]);
    });

    await raiseLimit(id);
    expect(await service.enforceSizeLimit(id, signal())).toMatchObject({ writesBlocked: false });
    await inDatabase({ ...credentials }, async (client) => {
      await client.query('INSERT INTO app.items VALUES (1)');
      expect((await client.query('SELECT app.definer() AS n')).rows).toEqual([{ n: 2 }]);
    });
  });

  async function states(databaseName: string): Promise<Record<string, string>> {
    return inDatabase({ databaseName }, async (client) => Object.fromEntries((await client.query(`
      SELECT tgname AS name, tgenabled::text AS state FROM pg_trigger WHERE tgrelid = 'notes'::regclass AND NOT tgisinternal
      UNION ALL SELECT rulename, ev_enabled::text FROM pg_rewrite WHERE ev_class = 'notes'::regclass`)).rows
      .map((row: { name: string; state: string }) => [row.name, row.state])));
  }

  it('disables user triggers and rules while blocked and restores only the ones the block disabled', async () => {
    const { id, credentials, service } = await owner([
      'CREATE TABLE notes (id int, body text)',
      'CREATE TABLE audit (body text)',
      `CREATE FUNCTION grow() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN INSERT INTO audit VALUES (repeat('x', 1000)); RETURN OLD; END $$`,
      'CREATE TRIGGER on_delete AFTER DELETE ON notes FOR EACH ROW EXECUTE FUNCTION grow()',
      'CREATE TRIGGER always_on AFTER DELETE ON notes FOR EACH ROW EXECUTE FUNCTION grow()',
      'ALTER TABLE notes ENABLE ALWAYS TRIGGER always_on',
      'CREATE TRIGGER owner_off AFTER DELETE ON notes FOR EACH ROW EXECUTE FUNCTION grow()',
      'ALTER TABLE notes DISABLE TRIGGER owner_off',
      `CREATE RULE copy_delete AS ON DELETE TO notes DO ALSO INSERT INTO audit VALUES ('rule')`,
      `CREATE RULE owner_rule AS ON DELETE TO notes DO ALSO INSERT INTO audit VALUES ('owner')`,
      'ALTER TABLE notes DISABLE RULE owner_rule',
      `INSERT INTO notes VALUES (1, 'a'), (2, 'b')`,
    ]);
    const before = await states(credentials.databaseName);
    expect(before).toEqual({ on_delete: 'O', always_on: 'A', owner_off: 'D', copy_delete: 'O', owner_rule: 'D' });

    expect(await service.enforceSizeLimit(id, signal())).toMatchObject({ writesBlocked: true });
    expect(await states(credentials.databaseName)).toEqual({
      on_delete: 'D', always_on: 'D', owner_off: 'D', copy_delete: 'D', owner_rule: 'D',
    });
    expect(await service.enforceSizeLimit(id, signal())).toMatchObject({ writesBlocked: true });
    await inDatabase({ ...credentials }, async (client) => {
      await client.query('SET default_transaction_read_only = off');
      expect((await client.query('DELETE FROM notes WHERE id = 1')).rowCount).toBe(1);
    });
    await inDatabase({ databaseName: credentials.databaseName }, async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM audit')).rows).toEqual([{ n: 0 }]);
    });

    await raiseLimit(id);
    expect(await service.enforceSizeLimit(id, signal())).toMatchObject({ writesBlocked: false });
    expect(await states(credentials.databaseName)).toEqual(before);
    const row = await db.executor.selectFrom('container_owner_databases').select('block_disabled')
      .where('clerk_user_id', '=', id).executeTakeFirstOrThrow();
    expect(row.block_disabled).toBeNull();
  });
});
