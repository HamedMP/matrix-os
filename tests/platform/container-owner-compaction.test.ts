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
  type OwnerDatabaseCredentials,
} from '../../packages/platform/src/substrates/container-owner-database.js';
import { createOwnerDatabaseCompactor } from '../../packages/platform/src/substrates/container-owner-compaction.js';
import { createOwnerDatabaseSizeSweeper } from '../../packages/platform/src/substrates/container-database-size-sweep.js';
import { createScopedPlatformDbs, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const SECRET = 's'.repeat(48);
const MIB = 1024 * 1024;
const signal = () => AbortSignal.timeout(60_000);
const realUrl = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!realUrl)('owner database compaction on a real PostgreSQL server with a non-superuser admin', () => {
  let db: PlatformDB;
  let superuser: pg.Pool;
  let adminRole: string;
  let admin: PgOwnerClusterAdmin;
  let scoped: ScopedPlatformDbs;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    superuser = new pg.Pool({ connectionString: realUrl, max: 2 });
    adminRole = `mx_compact_admin_${randomUUID().slice(0, 8)}`;
    await superuser.query(`CREATE ROLE ${adminRole} LOGIN PASSWORD 'compact-admin' NOSUPERUSER CREATEROLE CREATEDB`);
    await superuser.query(`GRANT pg_signal_backend TO ${adminRole}`);
    const url = new URL(realUrl!);
    url.username = adminRole;
    url.password = 'compact-admin';
    admin = createPgOwnerClusterAdmin({ connectionString: url.toString() });
    scoped = await createScopedPlatformDbs('compaction', 1);
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

  function connect(credentials: { databaseName: string; roleName: string; password: string }): pg.Client {
    const url = new URL(realUrl!);
    url.username = credentials.roleName;
    url.password = credentials.password;
    url.pathname = `/${credentials.databaseName}`;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on('error', () => undefined);
    return client;
  }

  async function holderMemberships(): Promise<string[]> {
    const result = await superuser.query(`SELECT r.rolname FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
      WHERE u.rolname = $1 AND r.rolname LIKE 'mxh\\_%' AND (m.set_option OR m.inherit_option)`, [adminRole]);
    return result.rows.map((row: { rolname: string }) => row.rolname);
  }

  async function blockedAt(owner: string): Promise<Date | null> {
    return (await db.executor.selectFrom('container_owner_databases').select('writes_blocked_at')
      .where('clerk_user_id', '=', owner).executeTakeFirstOrThrow()).writes_blocked_at;
  }

  /** An owner over its limit and blocked, with a bulk table of 8,000 rows. */
  async function blockedOwner(adminOverride: PgOwnerClusterAdmin = admin, extraSetup: string[] = []) {
    const owner = `user_compact_${randomUUID().slice(0, 8)}`;
    const probe = createContainerOwnerDatabases({ db, admin, passwordSecret: SECRET, sizeLimitBytes: 1024 ** 3 });
    const credentials = await probe.ensure(owner, 1, signal());
    const base = Number((await superuser.query('SELECT pg_database_size($1)::bigint AS n', [credentials.databaseName])).rows[0].n);
    const sizeLimitBytes = base + 4 * MIB;
    await db.executor.updateTable('container_owner_databases').set({ size_limit_bytes: sizeLimitBytes })
      .where('clerk_user_id', '=', owner).execute();
    const service = createContainerOwnerDatabases({
      db, admin: adminOverride, passwordSecret: SECRET, sizeLimitBytes, sizeRestoreMarginBytes: MIB,
    });
    cleanups.push(() => service.remove(owner, signal()));
    const setup = connect(credentials);
    await setup.connect();
    await setup.query('CREATE TABLE notes (id serial PRIMARY KEY, body text)');
    await setup.query('CREATE TABLE bulk (id int PRIMARY KEY, body text)');
    await setup.query(`INSERT INTO bulk SELECT g, string_agg(md5(random()::text || g::text || s::text), '')
      FROM generate_series(1, 8000) g, generate_series(1, 20) s GROUP BY g`);
    for (const statement of extraSetup) await setup.query(statement);
    await setup.end();
    expect(await service.enforceSizeLimit(owner, signal())).toMatchObject({ writesBlocked: true });
    return { owner, credentials, service };
  }

  async function deleteMostRows(credentials: OwnerDatabaseCredentials): Promise<void> {
    const session = connect(credentials);
    await session.connect();
    await session.query('SET default_transaction_read_only = off');
    expect((await session.query('DELETE FROM bulk WHERE id % 10 <> 0')).rowCount).toBe(7200);
    await session.end();
  }

  it('compacts a blocked owner who deleted most rows, and writes come back without a TRUNCATE', async () => {
    const { owner, credentials, service } = await blockedOwner(admin, [
      `CREATE INDEX notes_lower ON notes (lower(body)) WHERE body <> ''`,
    ]);
    await deleteMostRows(credentials);
    const before = Number((await superuser.query('SELECT pg_database_size($1)::bigint AS n', [credentials.databaseName])).rows[0].n);
    const sweeper = createOwnerDatabaseSizeSweeper({
      db, ownerDatabases: service, compactor: createOwnerDatabaseCompactor({ admin, ownerDatabases: service }),
    });
    try {
      expect(await sweeper.sweepOnce()).toEqual({ ran: true, enforced: 1, compacted: 1 });
    } finally {
      await sweeper.shutdown();
    }
    expect(await blockedAt(owner)).toBeNull();
    const after = Number((await superuser.query('SELECT pg_database_size($1)::bigint AS n', [credentials.databaseName])).rows[0].n);
    expect(after).toBeLessThan(before - 2 * MIB);
    expect(await holderMemberships()).toEqual([]);
    const session = connect(credentials);
    await session.connect();
    await session.query(`INSERT INTO notes (body) VALUES ('back')`);
    await session.query('CREATE TABLE extra (id int)');
    expect((await session.query('SELECT count(*)::int AS n FROM bulk')).rows).toEqual([{ n: 800 }]);
    await session.end();
  });

  it('does not rewrite tables when the live data would not fit below the restore threshold', async () => {
    const statements: string[] = [];
    const { owner, service } = await blockedOwner();
    const compactor = createOwnerDatabaseCompactor({ admin: recording(admin, statements), ownerDatabases: service });
    expect(await compactor.compactFirst([owner], signal())).toEqual({ owner, outcome: 'would_not_fit' });
    expect(statements.some((statement) => statement.startsWith('VACUUM (FULL)'))).toBe(false);
    expect(await blockedAt(owner)).toBeInstanceOf(Date);
    expect(await holderMemberships()).toEqual([]);
    expect(await compactor.compactFirst([owner], signal())).toBeNull();
  });

  it('skips an owner whose runtime holds locks in its database', async () => {
    const { owner, credentials, service } = await blockedOwner();
    await deleteMostRows(credentials);
    const holder = connect(credentials);
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM bulk');
    try {
      const compactor = createOwnerDatabaseCompactor({ admin, ownerDatabases: service });
      expect(await compactor.compactFirst([owner], signal())).toBeNull();
      expect(await blockedAt(owner)).toBeInstanceOf(Date);
      expect(await holderMemberships()).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('leaves no holder membership when the rewrite fails or the session dies', async () => {
    const { owner, credentials, service } = await blockedOwner();
    await deleteMostRows(credentials);
    const failing = recording(admin, [], (statement) => {
      if (statement.startsWith('VACUUM (FULL)')) throw Object.assign(new Error('lock timeout'), { code: '55P03' });
    });
    const compactor = createOwnerDatabaseCompactor({ admin: failing, ownerDatabases: service });
    await expect(compactor.compactFirst([owner], signal())).rejects.toThrow('lock timeout');
    expect(await holderMemberships()).toEqual([]);

    const aborting = new AbortController();
    const dying = recording(admin, [], (statement) => {
      if (statement.startsWith('VACUUM (FULL)')) aborting.abort();
    });
    const second = createOwnerDatabaseCompactor({ admin: dying, ownerDatabases: service });
    await expect(second.compactFirst([owner], aborting.signal)).rejects.toThrow();
    expect(await holderMemberships()).toEqual([]);
    expect(await blockedAt(owner)).toBeInstanceOf(Date);
  });

  it('refuses to compact when an index would run owner-authored code, without running VACUUM', async () => {
    const statements: string[] = [];
    const logged: Array<{ message: string; detail: Record<string, string> }> = [];
    const { owner, credentials, service } = await blockedOwner(admin, [
      'CREATE FUNCTION fold_case(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower($1) $$',
      'CREATE INDEX bulk_folded ON bulk (fold_case(body))',
    ]);
    await deleteMostRows(credentials);
    const compactor = createOwnerDatabaseCompactor({
      admin: recording(admin, statements), ownerDatabases: service,
      logError: (message, detail) => { logged.push({ message, detail }); },
    });
    expect(await compactor.compactFirst([owner], signal())).toEqual({ owner, outcome: 'unsafe_to_compact' });
    expect(statements.some((statement) => statement.startsWith('VACUUM'))).toBe(false);
    expect(statements.some((statement) => statement.startsWith('SET ROLE'))).toBe(false);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain(owner);
    expect(JSON.stringify(logged)).not.toContain(credentials.databaseName);
    expect(await blockedAt(owner)).toBeInstanceOf(Date);
    expect(await holderMemberships()).toEqual([]);
  });

  it('revokes a holder membership left behind by an earlier crash before compacting', async () => {
    const { owner, service } = await blockedOwner();
    const holder = (await service.compactionTarget(owner))!.holderSql;
    const leak = new pg.Client({ connectionString: (() => {
      const url = new URL(realUrl!);
      url.username = adminRole;
      url.password = 'compact-admin';
      return url.toString();
    })() });
    await leak.connect();
    await leak.query(`GRANT ${holder} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
    await leak.end();
    expect(await holderMemberships()).toHaveLength(1);
    const compactor = createOwnerDatabaseCompactor({ admin, ownerDatabases: service });
    await compactor.compactFirst([owner], signal());
    expect(await holderMemberships()).toEqual([]);
  });
});

function recording(
  base: PgOwnerClusterAdmin, statements: string[], fault?: (statement: string) => void,
): PgOwnerClusterAdmin {
  return {
    ...base,
    withDatabaseSession(database, sessionSignal, work) {
      return base.withDatabaseSession(database, sessionSignal, (query) => work(async (statement, params) => {
        statements.push(statement);
        fault?.(statement);
        return query(statement, params);
      }));
    },
  };
}
