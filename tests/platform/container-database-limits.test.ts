import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createOwnerDatabaseSizeSweeper } from '../../packages/platform/src/substrates/container-database-size-sweep.js';
import {
  createContainerOwnerDatabases,
  type OwnerClusterAdmin,
} from '../../packages/platform/src/substrates/container-owner-database.js';
import { createPgOwnerClusterAdmin } from '../../packages/platform/src/substrates/container-owner-cluster-admin.js';
import { loadContainerSubstrateConfig } from '../../packages/platform/src/substrates/container-substrate-config.js';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const SECRET = 's'.repeat(48);
const signal = () => AbortSignal.timeout(10_000);

type Cluster = Awaited<ReturnType<typeof createTestPGlite>>;

/** PGlite stands in for the owner cluster; the reported size is scripted per database. */
function scriptedAdmin(cluster: Cluster, sizes: Map<string, number>, log: string[]): OwnerClusterAdmin {
  return {
    async query(statement, params) {
      log.push(statement);
      if (statement.includes('pg_database_size')) return [{ size_bytes: String(sizes.get(String(params[0])) ?? 0) }];
      return (await cluster.client.query(statement, [...params])).rows as Record<string, unknown>[];
    },
    async executeInDatabase() {},
  };
}

async function roleSettings(cluster: Cluster, roleName: string): Promise<string[]> {
  const result = await cluster.client.query<{ rolconfig: string[] | null }>(
    'SELECT rolconfig FROM pg_roles WHERE rolname = $1', [roleName]);
  return result.rows[0]?.rolconfig ?? [];
}

describe('owner database size limit', () => {
  let db: PlatformDB;
  let cluster: Cluster;
  let sizes: Map<string, number>;
  let log: string[];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    cluster = await createTestPGlite();
    sizes = new Map();
    log = [];
  });
  afterEach(async () => {
    await destroyTestPlatformDb(db);
    await cluster.client.close();
  });

  const owners = () => createContainerOwnerDatabases({
    db, admin: scriptedAdmin(cluster, sizes, log), passwordSecret: SECRET, sizeLimitBytes: 1000,
  });

  it('makes new sessions read-only once the database passes its limit, and lifts it when back under', async () => {
    const service = owners();
    const credentials = await service.ensure('user_limit_a', 1, signal());
    sizes.set(credentials.databaseName, 1500);
    log.length = 0;

    expect(await service.enforceSizeLimit('user_limit_a', signal()))
      .toEqual({ sizeBytes: 1500, overLimit: true, writesBlocked: true });
    expect(await roleSettings(cluster, credentials.roleName)).toContain('default_transaction_read_only=on');
    expect(log.some(statement => statement.includes('pg_terminate_backend'))).toBe(true);

    log.length = 0;
    expect(await service.enforceSizeLimit('user_limit_a', signal()))
      .toEqual({ sizeBytes: 1500, overLimit: true, writesBlocked: true });
    expect(log.some(statement => statement.includes('pg_terminate_backend'))).toBe(false);

    sizes.set(credentials.databaseName, 899);
    expect(await service.enforceSizeLimit('user_limit_a', signal()))
      .toEqual({ sizeBytes: 899, overLimit: false, writesBlocked: false });
    expect(await roleSettings(cluster, credentials.roleName)).not.toContain('default_transaction_read_only=on');
    expect(await roleSettings(cluster, credentials.roleName)).toContain('statement_timeout=30s');
  });

  it('keeps the size block when a later start re-provisions the role', async () => {
    const service = owners();
    const credentials = await service.ensure('user_limit_b', 1, signal());
    sizes.set(credentials.databaseName, 5000);
    await service.enforceSizeLimit('user_limit_b', signal());
    await service.ensure('user_limit_b', 2, signal());
    expect(await roleSettings(cluster, credentials.roleName)).toContain('default_transaction_read_only=on');
  });

  it('sweeps active databases, least recently measured first, in bounded batches', async () => {
    const service = owners();
    const a = await service.ensure('user_limit_c', 1, signal());
    const b = await service.ensure('user_limit_d', 1, signal());
    const fenced = await service.ensure('user_limit_e', 1, signal());
    await service.fence('user_limit_e', signal());
    sizes.set(a.databaseName, 2000);
    sizes.set(b.databaseName, 10);
    sizes.set(fenced.databaseName, 2000);
    const sweeper = createOwnerDatabaseSizeSweeper({ db, ownerDatabases: service, batchSize: 2 });

    expect(await sweeper.sweepOnce()).toEqual({ ran: true, enforced: 2 });
    expect(await roleSettings(cluster, a.roleName)).toContain('default_transaction_read_only=on');
    expect(await roleSettings(cluster, b.roleName)).not.toContain('default_transaction_read_only=on');
    expect(await roleSettings(cluster, fenced.roleName)).not.toContain('default_transaction_read_only=on');
    await sweeper.shutdown();
  });
});

describe('owner database limit settings', () => {
  const base = {
    MATRIX_CONTAINER_SUBSTRATE_ENABLED: 'true',
    MATRIX_CONTAINER_REGION: 'eu-central-1',
    MATRIX_CONTAINER_IMAGE: 'image',
    MATRIX_CONTAINER_INGRESS_CONNECTORS: 'in-1',
    MATRIX_CONTAINER_EGRESS_CONNECTORS: 'out-1',
    MATRIX_CONTAINER_OWNER_DB_ADMIN_URL: 'postgresql://admin@db.internal/postgres',
    MATRIX_CONTAINER_OWNER_DB_RUNTIME_HOST: 'db.internal',
    MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET: 'p'.repeat(40),
    MATRIX_CONTAINER_PLATFORM_URL: 'https://platform.internal',
    PLATFORM_SECRET: 'x'.repeat(40),
  };

  it('defaults to 500 MB and five connections', () => {
    const loaded = loadContainerSubstrateConfig(base);
    expect(loaded.ok && loaded.config.ownerDatabase).toMatchObject({ sizeLimitBytes: 500 * 1000 ** 2, connectionLimit: 5 });
  });

  it('rejects a connection limit outside 1 to 20 by setting name', () => {
    expect(loadContainerSubstrateConfig({ ...base, MATRIX_CONTAINER_OWNER_DB_CONNECTION_LIMIT: '50' }))
      .toEqual({ ok: false, reason: 'incomplete', invalid: ['MATRIX_CONTAINER_OWNER_DB_CONNECTION_LIMIT'] });
  });
});

const realUrl = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!realUrl)('owner database limits on a real PostgreSQL server', () => {
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

  function connect(databaseName: string, roleName: string, password: string): pg.Client {
    const url = new URL(realUrl!);
    url.username = roleName;
    url.password = password;
    url.pathname = `/${databaseName}`;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on('error', () => undefined);
    return client;
  }

  it('blocks default writes over the limit while reads still work, and limits connections on the role', async () => {
    const owner = `user_limit_${randomUUID().slice(0, 8)}`;
    const service = createContainerOwnerDatabases({ db, admin, passwordSecret: SECRET, sizeLimitBytes: 1, connectionLimit: 2 });
    const credentials = await service.ensure(owner, 1, signal());
    try {
      const setup = connect(credentials.databaseName, credentials.roleName, credentials.password);
      await setup.connect();
      await setup.query('CREATE TABLE notes (id int)');
      await setup.query('INSERT INTO notes VALUES (1)');
      await setup.end();

      expect((await service.enforceSizeLimit(owner, signal())).writesBlocked).toBe(true);
      const session = connect(credentials.databaseName, credentials.roleName, credentials.password);
      await session.connect();
      await expect(session.query('INSERT INTO notes VALUES (2)')).rejects.toMatchObject({ code: '25006' });
      expect((await session.query('SELECT count(*)::int AS n FROM notes')).rows).toEqual([{ n: 1 }]);
      const second = connect(credentials.databaseName, credentials.roleName, credentials.password);
      await second.connect();
      const third = connect(credentials.databaseName, credentials.roleName, credentials.password);
      await expect(third.connect()).rejects.toThrow(/too many connections/);
      await Promise.allSettled([session.end(), second.end()]);
    } finally {
      await service.remove(owner, signal());
    }
  });
});
