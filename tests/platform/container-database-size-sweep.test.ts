import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createPgOwnerClusterAdmin } from '../../packages/platform/src/substrates/container-owner-cluster-admin.js';
import {
  createContainerOwnerDatabases,
  type OwnerClusterAdmin,
} from '../../packages/platform/src/substrates/container-owner-database.js';
import { createOwnerDatabaseSizeSweeper } from '../../packages/platform/src/substrates/container-database-size-sweep.js';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createScopedPlatformDbs, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const SECRET = 's'.repeat(48);
const MIB = 1024 * 1024;
const signal = () => AbortSignal.timeout(20_000);

type Cluster = Awaited<ReturnType<typeof createTestPGlite>>;

function scriptedAdmin(cluster: Cluster, sizes: Map<string, number>, inDatabase: string[][] = []): OwnerClusterAdmin {
  return {
    async query(statement, params) {
      if (statement.includes('pg_database_size')) return [{ size_bytes: String(sizes.get(String(params[0])) ?? 0) }];
      return (await cluster.client.query(statement, [...params])).rows as Record<string, unknown>[];
    },
    async executeInDatabase(_database, statements) { inDatabase.push([...statements]); },
  };
}

describe('owner database size sweep', () => {
  let db: PlatformDB;
  let cluster: Cluster;
  let sizes: Map<string, number>;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    cluster = await createTestPGlite();
    sizes = new Map();
  });
  afterEach(async () => {
    await destroyTestPlatformDb(db);
    await cluster.client.close();
  });

  const blockedAt = async (owner: string) => (await db.executor.selectFrom('container_owner_databases')
    .select('writes_blocked_at').where('clerk_user_id', '=', owner).executeTakeFirstOrThrow()).writes_blocked_at;

  it('records the block, keeps it inside the hysteresis band, and lifts it below the limit minus the margin', async () => {
    const inDatabase: string[][] = [];
    const service = createContainerOwnerDatabases({
      db, admin: scriptedAdmin(cluster, sizes, inDatabase), passwordSecret: SECRET, sizeLimitBytes: 1000, sizeRestoreMarginBytes: 100,
    });
    const credentials = await service.ensure('user_sweep_a', 1, signal());
    sizes.set(credentials.databaseName, 1001);
    inDatabase.length = 0;
    expect(await service.enforceSizeLimit('user_sweep_a', signal())).toMatchObject({ writesBlocked: true });
    expect(await blockedAt('user_sweep_a')).toBeInstanceOf(Date);
    expect(inDatabase.flat().some((statement) => statement.startsWith('REASSIGN OWNED BY "mxr_'))).toBe(true);

    sizes.set(credentials.databaseName, 950);
    expect(await service.enforceSizeLimit('user_sweep_a', signal())).toMatchObject({ overLimit: false, writesBlocked: true });
    expect(await blockedAt('user_sweep_a')).toBeInstanceOf(Date);

    inDatabase.length = 0;
    sizes.set(credentials.databaseName, 899);
    expect(await service.enforceSizeLimit('user_sweep_a', signal())).toMatchObject({ writesBlocked: false });
    expect(await blockedAt('user_sweep_a')).toBeNull();
    expect(inDatabase.flat().some((statement) => statement.startsWith('REASSIGN OWNED BY "mxh_'))).toBe(true);
  });

  it('does not grant create back when a later start re-provisions a blocked owner', async () => {
    const inDatabase: string[][] = [];
    const statements: string[] = [];
    const base = scriptedAdmin(cluster, sizes, inDatabase);
    const admin: OwnerClusterAdmin = { ...base, async query(statement, params, s) { statements.push(statement); return base.query(statement, params, s); } };
    const service = createContainerOwnerDatabases({ db, admin, passwordSecret: SECRET, sizeLimitBytes: 1000 });
    const credentials = await service.ensure('user_sweep_b', 1, signal());
    sizes.set(credentials.databaseName, 5000);
    await service.enforceSizeLimit('user_sweep_b', signal());
    statements.length = 0;
    inDatabase.length = 0;
    await service.ensure('user_sweep_b', 2, signal());
    expect(statements.filter((statement) => /GRANT .*CREATE/.test(statement))).toEqual([]);
    expect(inDatabase.flat().filter((statement) => /GRANT .*CREATE/.test(statement))).toEqual([]);
  });
});

const realUrl = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!realUrl)('owner database size sweep on a real PostgreSQL server with a non-superuser admin', () => {
  let db: PlatformDB;
  let superuser: pg.Pool;
  let adminRole: string;
  let admin: ReturnType<typeof createPgOwnerClusterAdmin>;
  let scoped: ScopedPlatformDbs;

  beforeAll(async () => {
    superuser = new pg.Pool({ connectionString: realUrl, max: 1 });
    adminRole = `mx_sweep_admin_${randomUUID().slice(0, 8)}`;
    await superuser.query(`CREATE ROLE ${adminRole} LOGIN PASSWORD 'sweep-admin' NOSUPERUSER CREATEROLE CREATEDB`);
    await superuser.query(`GRANT pg_signal_backend TO ${adminRole}`);
    const url = new URL(realUrl!);
    url.username = adminRole;
    url.password = 'sweep-admin';
    admin = createPgOwnerClusterAdmin({ connectionString: url.toString() });
    scoped = await createScopedPlatformDbs('size_sweep', 2);
  });
  afterAll(async () => {
    await admin?.close();
    await scoped?.close();
    await superuser.query(`DROP ROLE IF EXISTS ${adminRole}`);
    await superuser.end();
  });
  beforeEach(async () => { [db] = scoped.pools as [PlatformDB]; });

  function connect(credentials: { databaseName: string; roleName: string; password: string }): pg.Client {
    const url = new URL(realUrl!);
    url.username = credentials.roleName;
    url.password = credentials.password;
    url.pathname = `/${credentials.databaseName}`;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on('error', () => undefined);
    return client;
  }

  async function baseline(databaseName: string): Promise<number> {
    return Number((await superuser.query('SELECT pg_database_size($1)::bigint AS n', [databaseName])).rows[0].n);
  }

  it('refuses writes the owner cannot re-enable, keeps reads and deletes, survives a restart, and restores after cleanup', async () => {
    const owner = `user_sweep_${randomUUID().slice(0, 8)}`;
    const probe = createContainerOwnerDatabases({ db, admin, passwordSecret: SECRET, sizeLimitBytes: 1024 ** 3 });
    const credentials = await probe.ensure(owner, 1, signal());
    const sizeLimitBytes = await baseline(credentials.databaseName) + 4 * MIB;
    const service = createContainerOwnerDatabases({
      db, admin, passwordSecret: SECRET, sizeLimitBytes, sizeRestoreMarginBytes: MIB,
    });
    await db.executor.updateTable('container_owner_databases').set({ size_limit_bytes: sizeLimitBytes })
      .where('clerk_user_id', '=', owner).execute();
    const sweeper = createOwnerDatabaseSizeSweeper({ db, ownerDatabases: service });
    try {
      const setup = connect(credentials);
      await setup.connect();
      await setup.query('CREATE TABLE notes (id serial PRIMARY KEY, body text)');
      await setup.query('CREATE TABLE bulk (body text)');
      await setup.query(`CREATE FUNCTION write_note() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO notes (body) VALUES ('definer') $$`);
      await setup.query(`INSERT INTO notes (body) VALUES ('keep'), ('drop')`);
      await setup.query(`INSERT INTO bulk SELECT string_agg(md5(random()::text || g::text || s::text), '')
        FROM generate_series(1, 8000) g, generate_series(1, 20) s GROUP BY g`);
      await setup.end();

      expect(await sweeper.sweepOnce()).toEqual({ ran: true, enforced: 1 });
      const blocked = await db.executor.selectFrom('container_owner_databases').select('writes_blocked_at')
        .where('clerk_user_id', '=', owner).executeTakeFirstOrThrow();
      expect(blocked.writes_blocked_at).toBeInstanceOf(Date);

      const session = connect(credentials);
      await session.connect();
      await session.query('SET default_transaction_read_only = off');
      for (const statement of [
        `INSERT INTO notes (body) VALUES ('new')`,
        `UPDATE notes SET body = 'changed'`,
        'CREATE TABLE extra (id int)',
        'CREATE SCHEMA mine',
        'CREATE TEMP TABLE scratch (id int)',
        'ALTER TABLE notes ADD COLUMN extra int',
        'SELECT write_note()',
        `SELECT nextval('notes_id_seq')`,
      ]) {
        await expect(session.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      }
      expect((await session.query('SELECT body FROM notes ORDER BY id')).rows).toEqual([{ body: 'keep' }, { body: 'drop' }]);
      expect((await session.query(`DELETE FROM notes WHERE body = 'drop'`)).rowCount).toBe(1);
      await session.end();

      await service.ensure(owner, 2, signal());
      const restarted = connect({ ...credentials, password: service.passwordFor(credentials.roleName, 2) });
      await restarted.connect();
      await restarted.query('SET default_transaction_read_only = off');
      await expect(restarted.query('CREATE TABLE after_restart (id int)')).rejects.toMatchObject({ code: '42501' });
      await expect(restarted.query(`INSERT INTO notes (body) VALUES ('new')`)).rejects.toMatchObject({ code: '42501' });
      await restarted.query('TRUNCATE bulk');
      await restarted.end();

      expect(await sweeper.sweepOnce()).toEqual({ ran: true, enforced: 1 });
      const lifted = await db.executor.selectFrom('container_owner_databases').select('writes_blocked_at')
        .where('clerk_user_id', '=', owner).executeTakeFirstOrThrow();
      expect(lifted.writes_blocked_at).toBeNull();
      const reopened = connect({ ...credentials, password: service.passwordFor(credentials.roleName, 2) });
      await reopened.connect();
      await reopened.query(`INSERT INTO notes (body) VALUES ('back')`);
      await reopened.query('CREATE TABLE extra (id int)');
      await reopened.query('SELECT write_note()');
      expect((await reopened.query('SELECT count(*)::int AS n FROM notes')).rows).toEqual([{ n: 3 }]);
      await reopened.end();
    } finally {
      await sweeper.shutdown();
      await service.remove(owner, signal());
    }
    const leftovers = await superuser.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)',
      [[credentials.roleName, `mxh_${credentials.roleName.slice(4)}`]]);
    expect(leftovers.rows).toEqual([]);
  });

  it('runs one sweep at a time across platform instances', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const owner = `user_sweep_${randomUUID().slice(0, 8)}`;
    await a.executor.insertInto('container_owner_databases').values({
      clerk_user_id: owner, database_name: `mxo_${'a'.repeat(26)}`, role_name: `mxr_${'a'.repeat(26)}`,
      size_limit_bytes: 1000, state: 'active', password_epoch: 1,
    }).execute();
    const enforce = async () => ({ sizeBytes: 0, overLimit: false, writesBlocked: false });
    const slow = createOwnerDatabaseSizeSweeper({ db: a, ownerDatabases: { async enforceSizeLimit() { entered(); await gate; return enforce(); } } });
    const other = createOwnerDatabaseSizeSweeper({ db: b, ownerDatabases: { enforceSizeLimit: enforce } });
    try {
      const first = slow.sweepOnce();
      await started;
      expect(await other.sweepOnce()).toEqual({ ran: false, enforced: 0 });
      release();
      expect((await first).ran).toBe(true);
      expect((await other.sweepOnce()).ran).toBe(true);
    } finally {
      release();
      await Promise.all([slow.shutdown(), other.shutdown()]);
      await a.executor.deleteFrom('container_owner_databases').where('clerk_user_id', '=', owner).execute();
    }
  });
});
