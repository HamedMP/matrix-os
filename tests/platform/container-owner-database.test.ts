import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  ContainerOwnerDatabaseError,
  assertOwnerIdentifier,
  createContainerOwnerDatabases,
  type OwnerClusterAdmin,
} from '../../packages/platform/src/substrates/container-owner-database.js';
import { createPgOwnerClusterAdmin } from '../../packages/platform/src/substrates/container-owner-cluster-admin.js';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const SECRET = 's'.repeat(48);
const signal = () => AbortSignal.timeout(10_000);

type Cluster = Awaited<ReturnType<typeof createTestPGlite>>;

/**
 * PGlite has one database per engine, so each owner database's `public` schema
 * is stood in for by a schema of the same name, dropped with the database.
 */
function pgliteAdmin(cluster: Cluster, log: string[]): OwnerClusterAdmin {
  return {
    async query(statement, params) {
      log.push(statement);
      const result = await cluster.client.query(statement, [...params]);
      const dropped = /^DROP DATABASE IF EXISTS ("mxo_[a-z2-7]{26}")/.exec(statement);
      if (dropped) await cluster.client.query(`DROP SCHEMA IF EXISTS ${dropped[1]} CASCADE`);
      return result.rows as Record<string, unknown>[];
    },
    async executeInDatabase(database, statements) {
      await cluster.client.query(`CREATE SCHEMA IF NOT EXISTS "${database}"`);
      for (const statement of statements) {
        log.push(`[${database}] ${statement}`);
        await cluster.client.query(statement.replace('SCHEMA public', `SCHEMA "${database}"`));
      }
    },
  };
}

async function role(cluster: Cluster, name: string) {
  const result = await cluster.client.query<Record<string, unknown>>(
    `SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls,
            r.rolconnlimit, r.rolconfig, a.rolpassword
       FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid WHERE r.rolname = $1`, [name]);
  return result.rows[0];
}

async function database(cluster: Cluster, name: string) {
  const result = await cluster.client.query<{ datconnlimit: number }>(
    'SELECT datconnlimit FROM pg_database WHERE datname = $1', [name]);
  return result.rows[0];
}

describe('container owner databases', () => {
  let db: PlatformDB;
  let cluster: Cluster;
  let log: string[];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    cluster = await createTestPGlite();
    log = [];
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    await cluster.client.close();
  });

  const service = () => createContainerOwnerDatabases({
    db, admin: pgliteAdmin(cluster, log), passwordSecret: SECRET, sizeLimitBytes: 1024 ** 3,
  });

  it('creates an opaque NOSUPERUSER role and database limited to five connections', async () => {
    const credentials = await service().ensure('user_owner_a', 1, signal());

    expect(credentials.databaseName).toMatch(/^mxo_[a-z2-7]{26}$/);
    expect(credentials.roleName).toMatch(/^mxr_[a-z2-7]{26}$/);
    expect(credentials.databaseName).not.toContain('owner_a');
    expect(credentials.passwordEpoch).toBe(1);
    expect(await role(cluster, credentials.roleName)).toMatchObject({
      rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false, rolconnlimit: 5,
    });
    expect((await role(cluster, credentials.roleName))?.rolconfig).toEqual(expect.arrayContaining([
      'statement_timeout=30s', 'idle_in_transaction_session_timeout=60s', 'lock_timeout=10s',
    ]));
    expect(await database(cluster, credentials.databaseName)).toEqual({ datconnlimit: 5 });
    const privileges = await cluster.client.query<Record<string, boolean>>(
      `SELECT has_database_privilege($1, $2, 'CONNECT') AS connect, has_database_privilege($1, $2, 'CREATE') AS "create",
              has_database_privilege($1, $2, 'TEMPORARY') AS temp`, [credentials.roleName, credentials.databaseName]);
    expect(privileges.rows[0]).toEqual({ connect: true, create: true, temp: false });
    expect(log).toContain(`[${credentials.databaseName}] REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    expect(log).toContain(`[${credentials.databaseName}] GRANT USAGE, CREATE ON SCHEMA public TO "${credentials.roleName}"`);
  });

  it('records the database without its password', async () => {
    const credentials = await service().ensure('user_owner_a', 1, signal());
    const rows = await db.executor.selectFrom('container_owner_databases').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clerk_user_id: 'user_owner_a', database_name: credentials.databaseName, role_name: credentials.roleName,
      connection_limit: 5, state: 'active', password_epoch: 1, size_limit_bytes: 1024 ** 3,
    });
    expect(JSON.stringify(rows)).not.toContain(credentials.password);
  });

  it('is idempotent and returns the same names and password for the same generation', async () => {
    const first = await service().ensure('user_owner_a', 1, signal());
    const second = await service().ensure('user_owner_a', 1, signal());
    expect(second).toEqual(first);
    const roles = await cluster.client.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'mxr_%'");
    expect(roles.rows).toEqual([{ n: 1 }]);
  });

  it('settles concurrent first creates on one record and one role', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => service().ensure('user_owner_a', 1, signal())));
    expect(new Set(results.map(r => r.roleName)).size).toBe(1);
    expect(await db.executor.selectFrom('container_owner_databases').select('role_name').execute()).toHaveLength(1);
  });

  it('rotates the password to a newer generation, terminates the role sessions, and never goes back', async () => {
    const owners = service();
    const first = await owners.ensure('user_owner_a', 1, signal());
    const hashBefore = (await role(cluster, first.roleName))?.rolpassword;

    expect(await owners.rotate('user_owner_a', 2, signal())).toEqual({ rotated: true, passwordEpoch: 2 });
    const hashAfter = (await role(cluster, first.roleName))?.rolpassword;
    expect(hashAfter).not.toEqual(hashBefore);
    const terminateIndex = log.findIndex(s => s.includes('pg_terminate_backend'));
    const alterIndex = log.findIndex(s => s.startsWith(`ALTER ROLE "${first.roleName}" PASSWORD`));
    expect(alterIndex).toBeGreaterThan(-1);
    expect(terminateIndex).toBeGreaterThan(alterIndex);

    expect(await owners.rotate('user_owner_a', 2, signal())).toEqual({ rotated: false, passwordEpoch: 2 });
    expect(await owners.rotate('user_owner_a', 1, signal())).toEqual({ rotated: false, passwordEpoch: 2 });
    expect((await role(cluster, first.roleName))?.rolpassword).toEqual(hashAfter);
    await expect(owners.ensure('user_owner_a', 1, signal())).rejects.toMatchObject({ code: 'stale_generation' });

    const current = await owners.ensure('user_owner_a', 2, signal());
    expect(current.password).not.toEqual(first.password);
    expect(current.passwordEpoch).toBe(2);
  });

  it('ensure at a newer generation rotates before returning credentials', async () => {
    const owners = service();
    await owners.ensure('user_owner_a', 1, signal());
    expect((await owners.ensure('user_owner_a', 3, signal())).passwordEpoch).toBe(3);
  });

  it('fences by disabling login and terminating sessions, and unfences', async () => {
    const owners = service();
    const credentials = await owners.ensure('user_owner_a', 1, signal());
    await owners.fence('user_owner_a', signal());
    expect((await role(cluster, credentials.roleName))?.rolcanlogin).toBe(false);
    expect(log.at(-1)).toContain('pg_terminate_backend');
    await expect(owners.ensure('user_owner_a', 1, signal())).rejects.toMatchObject({ code: 'fenced' });

    await owners.unfence('user_owner_a', signal());
    expect((await role(cluster, credentials.roleName))?.rolcanlogin).toBe(true);
    await expect(owners.ensure('user_owner_a', 1, signal())).resolves.toMatchObject({ roleName: credentials.roleName });
  });

  it('measures size against the platform-enforced limit', async () => {
    const owners = createContainerOwnerDatabases({
      db, admin: {
        ...pgliteAdmin(cluster, log),
        async query(statement, params) {
          if (statement.includes('pg_database_size')) return [{ size_bytes: '2048' }];
          return pgliteAdmin(cluster, log).query(statement, params, signal());
        },
      },
      passwordSecret: SECRET, sizeLimitBytes: 1024,
    });
    await owners.ensure('user_owner_a', 1, signal());
    expect(await owners.measureSize('user_owner_a', signal())).toEqual({ sizeBytes: 2048, overLimit: true });
    const row = await db.executor.selectFrom('container_owner_databases').selectAll().executeTakeFirstOrThrow();
    expect(Number(row.size_bytes)).toBe(2048);
    expect(row.size_measured_at).not.toBeNull();
  });

  it('removes the database and role, and a later ensure gets new names', async () => {
    const owners = service();
    const first = await owners.ensure('user_owner_a', 1, signal());
    await owners.remove('user_owner_a', signal());
    expect(await role(cluster, first.roleName)).toBeUndefined();
    expect(await database(cluster, first.databaseName)).toBeUndefined();
    const row = await db.executor.selectFrom('container_owner_databases').selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe('deleting');
    expect(row.deleted_at).not.toBeNull();
    await owners.remove('user_owner_a', signal());

    const second = await owners.ensure('user_owner_a', 4, signal());
    expect(second.roleName).not.toEqual(first.roleName);
    expect(second.passwordEpoch).toBe(4);
  });

  /**
   * Starts `interleave` once, just before the first statement matching each
   * pattern reaches the cluster, and gives it a moment to run. Owner database
   * work is serialized per owner, so a started operation may instead wait for
   * the one in progress; `settled` awaits everything that was started.
   */
  function interleaved(hooks: Array<[RegExp, () => Promise<unknown>]>) {
    const base = pgliteAdmin(cluster, log);
    const pending = hooks.map(([pattern, run]) => ({ pattern, run, fired: false }));
    const started: Promise<unknown>[] = [];
    const owners = createContainerOwnerDatabases({
      db, passwordSecret: SECRET, sizeLimitBytes: 1024 ** 3,
      admin: {
        ...base,
        async query(statement, params, s) {
          for (const hook of pending) {
            if (hook.fired || !hook.pattern.test(statement)) continue;
            hook.fired = true;
            const op = hook.run();
            started.push(op.catch((error: unknown) => error));
            await Promise.race([op.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 300))]);
          }
          return base.query(statement, params, s);
        },
      },
    });
    return { owners, settled: () => Promise.all(started) };
  }

  it('a fence that lands while ensure provisions leaves the role unable to log in', async () => {
    const credentials = await service().ensure('user_owner_a', 1, signal());
    const { owners, settled } = interleaved([[/WITH LOGIN/, () => service().fence('user_owner_a', signal())]]);

    await owners.ensure('user_owner_a', 1, signal()).catch((error: unknown) => error);
    await settled();
    const row = await db.executor.selectFrom('container_owner_databases').selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe('fenced');
    expect((await role(cluster, credentials.roleName))?.rolcanlogin).toBe(false);
  });

  it('a rotation that lands while ensure provisions leaves the newer password in force', async () => {
    const credentials = await service().ensure('user_owner_a', 1, signal());
    const { owners, settled } = interleaved([[/WITH LOGIN/, () => service().rotate('user_owner_a', 2, signal())]]);

    await owners.ensure('user_owner_a', 1, signal()).catch((error: unknown) => error);
    await settled();
    const newest = service().passwordFor(credentials.roleName, 2);
    const applied = log.filter(s => s.startsWith(`ALTER ROLE "${credentials.roleName}"`) && s.includes(' PASSWORD '));
    expect(applied.at(-1)).toContain(`'${newest}'`);
    expect((await db.executor.selectFrom('container_owner_databases').select('password_epoch').executeTakeFirstOrThrow())
      .password_epoch).toBe(2);
  });

  it('a delayed removal never tombstones the record that replaced the one it read', async () => {
    const first = await service().ensure('user_owner_a', 1, signal());
    let second: Awaited<ReturnType<ReturnType<typeof service>['ensure']>> | undefined;
    // Another removal and the owner's return race the slow removal.
    const { owners, settled } = interleaved([[/FROM pg_roles/, async () => {
      await service().remove('user_owner_a', signal());
      second = await service().ensure('user_owner_a', 2, signal());
    }]]);
    await owners.remove('user_owner_a', signal());
    await settled();

    expect(second!.databaseName).not.toEqual(first.databaseName);
    const row = await db.executor.selectFrom('container_owner_databases').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ database_name: second!.databaseName, state: 'active', deleted_at: null });
    expect(await role(cluster, second!.roleName)).toMatchObject({ rolcanlogin: true });
  });

  it('refuses identifiers that do not match the generated format before any SQL use', async () => {
    for (const bad of ['mxo_short', 'MXO_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'mxo_aaaaaaaaaaaaaaaaaaaaaaaaa"; DROP ROLE x; --', 'postgres']) {
      expect(() => assertOwnerIdentifier(bad, 'mxo_')).toThrow(ContainerOwnerDatabaseError);
    }
    expect(() => assertOwnerIdentifier(`mxo_${'a'.repeat(26)}`, 'mxo_')).not.toThrow();
    await expect(db.executor.insertInto('container_owner_databases').values({
      clerk_user_id: 'user_tampered', database_name: 'owner"db', role_name: `mxr_${'a'.repeat(26)}`,
      size_limit_bytes: 1, state: 'active', password_epoch: 1,
    }).execute()).rejects.toThrow();
    await expect(service().ensure('bad user id', 1, signal())).rejects.toMatchObject({ code: 'invalid_identifier' });
    await expect(service().ensure('user_owner_a', 0, signal())).rejects.toMatchObject({ code: 'stale_generation' });
  });

  it('rejects a short password secret at construction', () => {
    expect(() => createContainerOwnerDatabases({
      db, admin: pgliteAdmin(cluster, log), passwordSecret: 'short', sizeLimitBytes: 1,
    })).toThrow();
  });
});

const realUrl = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!realUrl)('container owner databases on a real PostgreSQL server', () => {
  let db: PlatformDB;
  let admin: ReturnType<typeof createPgOwnerClusterAdmin>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    admin = createPgOwnerClusterAdmin({ connectionString: realUrl! });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    await admin.close();
  });

  function ownerUrl(databaseName: string, roleName: string, password: string): string {
    const url = new URL(realUrl!);
    url.username = roleName;
    url.password = password;
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  it('enforces the connection limit, fences old sessions on rotation, and drops everything on remove', async () => {
    const owners = createContainerOwnerDatabases({ db, admin, passwordSecret: SECRET, sizeLimitBytes: 1024 ** 3 });
    const owner = `user_real_${randomUUID().slice(0, 8)}`;
    const first = await owners.ensure(owner, 1, signal());
    const clients: pg.Client[] = [];
    try {
      for (let i = 0; i < 5; i += 1) {
        const client = new pg.Client({ connectionString: ownerUrl(first.databaseName, first.roleName, first.password) });
        client.on('error', () => undefined);
        await client.connect();
        clients.push(client);
      }
      await clients[0]!.query('CREATE TABLE probe (id int)');
      const sixth = new pg.Client({ connectionString: ownerUrl(first.databaseName, first.roleName, first.password) });
      await expect(sixth.connect()).rejects.toThrow(/too many connections/);

      await owners.rotate(owner, 2, signal());
      await expect(clients[1]!.query('SELECT 1')).rejects.toThrow();
      const stale = new pg.Client({ connectionString: ownerUrl(first.databaseName, first.roleName, first.password) });
      await expect(stale.connect()).rejects.toThrow(/password authentication failed/);
      const current = await owners.ensure(owner, 2, signal());
      const fresh = new pg.Client({ connectionString: ownerUrl(current.databaseName, current.roleName, current.password) });
      await fresh.connect();
      await fresh.end();
    } finally {
      await Promise.allSettled(clients.map(c => c.end()));
      await owners.remove(owner, signal());
    }
    const gone = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [first.databaseName], signal());
    expect(gone).toEqual([]);
  });
});

describe.skipIf(!realUrl)('container owner database operations across platform instances', () => {
  let schema: string;
  let pools: PlatformDB[];
  let adminPool: pg.Pool;
  let cluster: Cluster;
  let log: string[];
  beforeEach(async () => {
    schema = `ownerdbserial_${randomUUID().replaceAll('-', '')}`;
    adminPool = new pg.Pool({ connectionString: realUrl, max: 1 });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pools = [];
    for (let index = 0; index < 2; index += 1) {
      const url = new URL(realUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      const instance = createPlatformDb(url.toString());
      pools.push(instance);
      await instance.ready;
    }
    cluster = await createTestPGlite();
    log = [];
  });
  afterEach(async () => {
    for (const instance of pools) await instance.destroy();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
    await cluster.client.close();
  });

  it('never exhausts a small platform pool when many owners are provisioned at once', async () => {
    const url = new URL(realUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const small = createPlatformDb({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url.toString(), max: 2 }) }) });
    try {
      await small.ready;
      const owners = createContainerOwnerDatabases({ db: small, admin: pgliteAdmin(cluster, log), passwordSecret: SECRET, sizeLimitBytes: 1024 ** 3 });
      const all = Promise.all(Array.from({ length: 6 }, (_, i) => owners.ensure(`user_pool_${i}`, 1, signal())));
      const outcome = await Promise.race([all.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('stuck'), 8_000))]);
      expect(outcome).toBe('done');
    } finally {
      await small.destroy();
    }
  });

  it('keeps the role login in step with the record when fence and unfence race a provisioning', async () => {
    const [a, b] = pools as [PlatformDB, PlatformDB];
    const started: Promise<unknown>[] = [];
    /** Starts `run` once, just before the first statement matching `pattern`, and gives it a moment. */
    function hooked(pattern: RegExp, run: () => Promise<unknown>): OwnerClusterAdmin {
      const base = pgliteAdmin(cluster, log);
      let fired = false;
      return {
        ...base,
        async query(statement, params, s) {
          if (!fired && pattern.test(statement)) {
            fired = true;
            const op = run();
            started.push(op.then(() => 'ok', (error: unknown) => error));
            await Promise.race([op.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 300))]);
          }
          return base.query(statement, params, s);
        },
      };
    }
    const make = (db: PlatformDB, admin: OwnerClusterAdmin) =>
      createContainerOwnerDatabases({ db, admin, passwordSecret: SECRET, sizeLimitBytes: 1024 ** 3 });
    const plain = make(b, pgliteAdmin(cluster, log));
    const credentials = await plain.ensure('user_owner_a', 1, signal());
    // The fence's NOLOGIN starts an unfence; the provisioning's LOGIN starts the fence.
    const fencer = make(b, hooked(/" NOLOGIN$/, () => plain.unfence('user_owner_a', signal())));
    const owners = make(a, hooked(/WITH LOGIN/, () => fencer.fence('user_owner_a', signal())));

    await owners.ensure('user_owner_a', 1, signal());
    // The fence and then the unfence ran; awaiting all three proves the unfence completed.
    while (started.length < 2) await new Promise(resolve => setTimeout(resolve, 50));
    expect(await Promise.all(started)).toEqual(['ok', 'ok']);
    const row = await a.executor.selectFrom('container_owner_databases').selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe('active');
    expect((await role(cluster, credentials.roleName))?.rolcanlogin).toBe(true);
  });
});
