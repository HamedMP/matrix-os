import { sql } from 'kysely';
import pg, { type Pool, type PoolConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import * as original from './platform-db-test-helper.js';
import { createNativePlatformFixtureManager, type NativePlatformFixtureManager } from './native-platform-db-test-helper.js';

const fixtureUrl = 'postgresql://fixture:fixture@127.0.0.1:5432/matrix_ci_platform_fixture_admin';
const liveUrl = process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL;
const managers: NativePlatformFixtureManager[] = [];
beforeEach(() => { vi.stubEnv('MATRIX_PLATFORM_FIXTURE_POSTGRES_URL', undefined); });
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function fakeNative(options: { startupFailure?: Error; cleanupFailure?: Error; blockedStartup?: Promise<void>; blockedCloneCreation?: Promise<void>; templateBytes?: string } = {}) {
  const events: string[] = [];
  const databases = new Set<string>(); // Bounded by the helper's fixed five names.
  let startupFailure = options.startupFailure;
  let cleanupFailure = options.cleanupFailure;
  const pools: Pool[] = [];
  const createPool = vi.fn((config: PoolConfig) => {
    const name = new URL(config.connectionString!).pathname.slice(1);
    const pool = {
      on: vi.fn(),
      query: vi.fn(async (query: string) => {
        events.push(query);
        const create = query.match(/^CREATE DATABASE "([^"]+)"/);
        const drop = query.match(/^DROP DATABASE IF EXISTS "([^"]+)"/);
        if (create) databases.add(create[1]);
        if (create?.[1].includes('_clone_')) await options.blockedCloneCreation;
        if (drop) databases.delete(drop[1]);
        return { rows: query.includes('pg_database_size') ? [{ bytes: options.templateBytes ?? '16777216' }] : query.includes('pg_stat_activity') ? [{ count: '0' }]
          : query.includes('pg_database') ? [...databases].map(datname => ({ datname })) : [] };
      }),
      end: vi.fn(async () => {
        events.push(`close:${name}`);
        if (cleanupFailure && name.endsWith('_template')) {
          const error = cleanupFailure; cleanupFailure = undefined; throw error;
        }
      }),
    } as unknown as Pool;
    pools.push(pool); return pool;
  });
  const createDatabase = vi.fn((dialect: unknown): PlatformDB => {
    const pool = pools.at(-1)!;
    const error = startupFailure; startupFailure = undefined;
    return {
      kysely: undefined, executor: undefined,
      ready: error ? Promise.reject(error) : options.blockedStartup ?? Promise.resolve(),
      destroy: vi.fn(() => pool.end()),
      transaction: vi.fn(),
    } as unknown as PlatformDB;
  });
  const manager = createNativePlatformFixtureManager({ createPool, createPlatformDb: createDatabase });
  managers.push(manager);
  return { manager, events, databases, createPool, createDatabase, pools };
}

describe('native platform fixture admission and lifecycle', () => {
  it('uses the original cached PGlite helper unchanged when the distinct URL is unset', async () => {
    const fallback = vi.spyOn(original, 'createTestPlatformDb');
    const destroy = vi.spyOn(original, 'destroyTestPlatformDb');
    const { manager, createPool } = fakeNative();
    const fixture = await manager.createTestPlatformDb();
    expect(Object.keys(fixture)).toEqual(['db']);
    expect(fallback).toHaveBeenCalledExactlyOnceWith();
    expect(createPool).not.toHaveBeenCalled();
    await manager.destroyTestPlatformDb(fixture.db);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(fixture.db);
  });

  it.each([
    '', 'https://127.0.0.1/matrix_ci_platform_fixture_admin',
    'postgresql://localhost/matrix_ci_platform_fixture_admin',
    'postgresql://192.168.1.1/matrix_ci_platform_fixture_admin',
    'postgresql://127.0.0.1/production',
    'postgresql://127.0.0.1/matrix_ci_platform_fixture_admin?options=-c%20search_path=public',
    'postgresql://127.0.0.1/matrix_ci_platform_fixture_admin#fragment',
  ])('rejects unsafe fixture configuration before allocating any pool: %s', async url => {
    const { manager, createPool } = fakeNative();
    await expect(manager.createTestPlatformDb(url)).rejects.toThrow(/fixture/i);
    expect(createPool).not.toHaveBeenCalled();
  });

  it('drains a pending fallback startup before shutdown and closes its late resource', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const create = original.createTestPlatformDb;
    vi.spyOn(original, 'createTestPlatformDb').mockImplementationOnce(async () => { await gate; return create(); });
    const destroy = vi.spyOn(original, 'destroyTestPlatformDb');
    const { manager } = fakeNative();
    const creation = manager.createTestPlatformDb().then(value => ({ value }), error => ({ error }));
    let finished = false;
    const shutdown = manager.shutdown().then(() => { finished = true; return {}; }, error => { finished = true; return { error }; });
    await Promise.resolve(); await Promise.resolve();
    const finishedBeforeStartup = finished;
    unblock();
    const created = await creation;
    const closed = await shutdown;
    managers.splice(managers.indexOf(manager), 1); // This test explicitly asserts the completed shutdown failure.
    try {
      expect(finishedBeforeStartup).toBe(false);
      expect(created).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/closed/i) }) });
      expect(closed).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/closed/i) }) });
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      if ('value' in created) await manager.destroyTestPlatformDb(created.value.db);
    }
  });

  it('coalesces one closed template and owns every fresh clone through teardown', async () => {
    const { manager, createDatabase, createPool, events, databases } = fakeNative();
    const [first, second] = await Promise.all([manager.createTestPlatformDb(fixtureUrl), manager.createTestPlatformDb(fixtureUrl)]);
    expect(first.db).not.toBe(second.db);
    expect(createDatabase).toHaveBeenCalledTimes(3);
    expect(createPool.mock.calls.every(([config]) => config.max === 1 && config.connectionTimeoutMillis! > 0 && config.query_timeout! > 0)).toBe(true);
    const cloneStart = events.findIndex(event => event.startsWith('CREATE DATABASE') && event.includes('_clone_'));
    expect(events.findIndex(event => event.startsWith('close:') && event.endsWith('_template'))).toBeLessThan(cloneStart);
    expect(events.some(event => event.startsWith('ALTER DATABASE') && event.endsWith('ALLOW_CONNECTIONS false'))).toBe(true);
    await manager.destroyTestPlatformDb(first.db);
    await manager.destroyTestPlatformDb(first.db);
    await manager.drainClones();
    expect(databases.size).toBe(1);
    await manager.shutdown();
    expect(databases.size).toBe(0);
  });

  it('invalidates fallback startup after an afterEach drain deadline and permits fresh admission', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const create = original.createTestPlatformDb;
    vi.spyOn(original, 'createTestPlatformDb').mockImplementationOnce(async () => { await gate; return create(); });
    const destroy = vi.spyOn(original, 'destroyTestPlatformDb');
    const { manager } = fakeNative();
    const creating = manager.createTestPlatformDb().then(value => ({ value }), error => ({ error }));
    vi.useFakeTimers();
    try {
      const drain = manager.drainClones();
      expect(manager.drainClones()).toBe(drain);
      const draining = drain.then(() => ({}), error => ({ error }));
      await expect(manager.createTestPlatformDb()).rejects.toThrow(/draining/i);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await draining).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/deadline/i) }) });
      vi.useRealTimers(); unblock();
      const outcome = await creating;
      try {
        expect(outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/drained|closed/i) }) });
        expect(destroy).toHaveBeenCalledOnce();
      } finally { if ('value' in outcome) await manager.destroyTestPlatformDb(outcome.value.db); }
      const fresh = await manager.createTestPlatformDb();
      await manager.destroyTestPlatformDb(fresh.db);
    } finally { vi.useRealTimers(); unblock(); await creating; }
  });

  it('invalidates late template startup before clone allocation after an afterEach drain deadline', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const { manager, createDatabase, databases, events } = fakeNative({ blockedStartup: gate });
    const creating = manager.createTestPlatformDb(fixtureUrl).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(createDatabase).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    try {
      const drain = manager.drainClones();
      expect(manager.drainClones()).toBe(drain);
      const draining = drain.then(() => ({}), error => ({ error }));
      await expect(manager.createTestPlatformDb()).rejects.toThrow(/draining/i);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await draining).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/deadline/i) }) });
      vi.useRealTimers(); unblock();
      const outcome = await creating;
      try {
        expect(outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/drained|closed/i) }) });
        expect(createDatabase).toHaveBeenCalledOnce();
        expect(events.filter(event => event.startsWith('CREATE DATABASE') && event.includes('_clone_'))).toEqual([]);
        expect(databases.size).toBe(1);
      } finally { if ('value' in outcome) await manager.destroyTestPlatformDb(outcome.value.db); }
      const fresh = await manager.createTestPlatformDb(fixtureUrl);
      await manager.destroyTestPlatformDb(fresh.db);
    } finally { vi.useRealTimers(); unblock(); await creating; }
  });

  it('resets failed template initialization for retry after disposing its resources', async () => {
    const failure = new Error('Synthetic template startup failure');
    const { manager, createDatabase, databases } = fakeNative({ startupFailure: failure });
    await expect(manager.createTestPlatformDb(fixtureUrl)).rejects.toBe(failure);
    expect(databases.size).toBe(0);
    const fixture = await manager.createTestPlatformDb(fixtureUrl);
    expect(createDatabase).toHaveBeenCalledTimes(3);
    await manager.destroyTestPlatformDb(fixture.db);
  });

  it('preserves template startup and pool cleanup failures together', async () => {
    const failure = new Error('Synthetic template startup failure');
    const cleanup = new Error('Synthetic template closure failure');
    const { manager } = fakeNative({ startupFailure: failure, cleanupFailure: cleanup });
    await expect(manager.createTestPlatformDb(fixtureUrl)).rejects.toMatchObject({ errors: [failure, cleanup] });
  });

  it('rejects an oversized template before cloning and removes its database', async () => {
    const { manager, createDatabase, databases } = fakeNative({ templateBytes: String(64 * 1024 * 1024 + 1) });
    await expect(manager.createTestPlatformDb(fixtureUrl)).rejects.toThrow(/64 MiB/);
    expect(createDatabase).toHaveBeenCalledOnce();
    expect(databases.size).toBe(0);
  });

  it('awaits unchanged clone startup and closes the failed clone before dropping its database', async () => {
    const failure = new Error('Synthetic clone startup failure');
    const { manager, createDatabase, databases, events } = fakeNative();
    const compose = createDatabase.getMockImplementation()!;
    createDatabase.mockImplementationOnce(compose).mockImplementationOnce(options => ({ ...compose(options), ready: Promise.reject(failure) }));
    await expect(manager.createTestPlatformDb(fixtureUrl)).rejects.toBe(failure);
    expect(createDatabase).toHaveBeenCalledTimes(2);
    expect(databases.size).toBe(1);
    const close = events.findIndex(event => event.startsWith('close:') && event.endsWith('_clone_0'));
    const drop = events.findIndex(event => event.startsWith('DROP DATABASE') && event.includes('_clone_0'));
    expect(close).toBeGreaterThan(-1); expect(drop).toBeGreaterThan(close);
  });

  it('still cleans allocated clones after a pending drain deadline and rejects late publication', async () => {
    const { manager, createDatabase, databases, pools } = fakeNative();
    await manager.createTestPlatformDb(fixtureUrl);
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const compose = createDatabase.getMockImplementation()!;
    createDatabase.mockImplementationOnce(options => ({ ...compose(options), ready: gate }));
    const creating = manager.createTestPlatformDb(fixtureUrl).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(createDatabase).toHaveBeenCalledTimes(3));
    vi.useFakeTimers();
    try {
      const draining = manager.drainClones().then(() => ({}), error => ({ error }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await draining).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/deadline/i) }) });
      expect(databases.size).toBe(1);
      vi.useRealTimers();
      const fresh = await Promise.all([manager.createTestPlatformDb(fixtureUrl), manager.createTestPlatformDb(fixtureUrl)]);
      const freshPool = pools.at(-1)!;
      unblock();
      expect(await creating).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/closed/i) }) });
      expect(databases.size).toBe(3);
      expect(freshPool.end).not.toHaveBeenCalled();
      await Promise.all(fresh.map(fixture => manager.destroyTestPlatformDb(fixture.db)));
    } finally {
      vi.useRealTimers(); unblock(); await creating;
      await manager.drainClones();
    }
  });

  it('caps pending and live clones at four fixed names before any fifth allocation', async () => {
    const { manager, databases } = fakeNative();
    const four = Array.from({ length: 4 }, () => manager.createTestPlatformDb(fixtureUrl));
    await expect(manager.createTestPlatformDb(fixtureUrl)).rejects.toThrow(/cap/i);
    const fixtures = await Promise.all(four);
    expect(databases.size).toBe(5);
    await manager.drainClones();
    expect(databases.size).toBe(1);
    // A released slot is a newly cloned database, with no retained connection.
    const next = await manager.createTestPlatformDb(fixtureUrl);
    expect(fixtures.map(fixture => fixture.db)).not.toContain(next.db);
    await manager.destroyTestPlatformDb(next.db);
  });

  it('does not open a clone pool when database creation finishes after its owner drain', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const { manager, databases, createPool, createDatabase } = fakeNative({ blockedCloneCreation: gate });
    const creating = manager.createTestPlatformDb(fixtureUrl).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(databases.size).toBe(2));
    vi.useFakeTimers();
    try {
      const draining = manager.drainClones().then(() => ({}), error => ({ error }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await draining).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/deadline/i) }) });
      vi.useRealTimers(); unblock();
      expect(await creating).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/closed|drained/i) }) });
      expect(createDatabase).toHaveBeenCalledOnce();
      expect(createPool).toHaveBeenCalledTimes(2); // Admin plus template; never a late clone pool.
      expect(databases.size).toBe(1);
    } finally { vi.useRealTimers(); unblock(); await creating; }
  });
});

describe.skipIf(!liveUrl)('native platform fixtures against disposable PostgreSQL', () => {
  it('preserves schema, defaults, seed data, concurrent rows, sequences and rollback isolation', async () => {
    const manager = createNativePlatformFixtureManager(); managers.push(manager);
    const [first, second] = await Promise.all([manager.createTestPlatformDb(liveUrl), manager.createTestPlatformDb(liveUrl)]);
    const sqlDb = (fixture: { db: PlatformDB }) => fixture.db.kysely;
    for (const fixture of [first, second]) {
      expect((await sql`SELECT policy_id,enabled,revision FROM ai_funded_global_policy`.execute(sqlDb(fixture))).rows)
        .toEqual([{ policy_id: 'default', enabled: false, revision: 0 }]);
      expect((await sql`SELECT scope FROM platform_schema_revisions ORDER BY scope`.execute(sqlDb(fixture))).rows)
        .toEqual([{ scope: 'core' }, { scope: 'whatsapp' }]);
      const user = (await sql`INSERT INTO users(clerk_id,handle,display_name,email,container_id)
        VALUES('same','same','Fixture','fixture@example.test','same') RETURNING id,plan,status`.execute(sqlDb(fixture))).rows[0];
      expect(user).toMatchObject({ id: expect.any(String), plan: 'free', status: 'active' });
      await sql`CREATE TABLE fixture_isolation(id SERIAL PRIMARY KEY,value TEXT UNIQUE NOT NULL)`.execute(sqlDb(fixture));
      await sql`INSERT INTO fixture_isolation(value) VALUES('same')`.execute(sqlDb(fixture));
    }
    await sql`UPDATE ai_funded_global_policy SET revision=9`.execute(sqlDb(first));
    await sql`INSERT INTO fixture_isolation(value) VALUES('first_only')`.execute(sqlDb(first));
    expect((await sql<{ revision: number }>`SELECT revision FROM ai_funded_global_policy`.execute(sqlDb(second))).rows[0].revision).toBe(0);
    expect((await sql`SELECT id,value FROM fixture_isolation ORDER BY id`.execute(sqlDb(first))).rows)
      .toEqual([{ id: 1, value: 'same' }, { id: 2, value: 'first_only' }]);
    expect((await sql`SELECT id,value FROM fixture_isolation`.execute(sqlDb(second))).rows).toEqual([{ id: 1, value: 'same' }]);
    const rollback = new Error('Intentional rollback');
    await expect(second.db.transaction(async trx => {
      await sql`INSERT INTO fixture_isolation(value) VALUES('rolled_back')`.execute(trx.kysely);
      await sql`UPDATE ai_funded_global_policy SET revision=77`.execute(trx.kysely);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await sql<{ revision: number }>`SELECT revision FROM ai_funded_global_policy`.execute(sqlDb(second))).rows[0].revision).toBe(0);
    expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM fixture_isolation`.execute(sqlDb(second))).rows[0].count).toBe(1);
    const next = async (fixture: { db: PlatformDB }) => String((await sql<{ value: string }>`SELECT nextval(pg_get_serial_sequence('fixture_isolation','id')) AS value`.execute(sqlDb(fixture))).rows[0].value);
    expect(await next(first)).toBe('3'); expect(await next(second)).toBe('3'); expect(await next(first)).toBe('4');
    await manager.drainClones();
    const fresh = await manager.createTestPlatformDb(liveUrl);
    expect((await sql<{ revision: number }>`SELECT revision FROM ai_funded_global_policy`.execute(sqlDb(fresh))).rows[0].revision).toBe(0);
    expect((await sql<{ name: string | null }>`SELECT to_regclass('fixture_isolation')::text AS name`.execute(sqlDb(fresh))).rows[0].name).toBeNull();
  }, 30_000);

  it('drops clones and the closed template, and verifies the owning pool closes', async () => {
    const pools: Pool[] = [];
    const createPool = (config: PoolConfig) => { const pool = new pg.Pool(config); pools.push(pool); return pool; };
    const manager = createNativePlatformFixtureManager({ createPool }); managers.push(manager);
    const fixture = await manager.createTestPlatformDb(liveUrl);
    const clone = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(fixture.db.kysely)).rows[0].name;
    const prefix = clone.replace(/_clone_\d$/, '');
    const closedTemplate = await pools[0].query('SELECT datallowconn FROM pg_database WHERE datname=$1', [`${prefix}_template`]);
    expect(closedTemplate.rows).toEqual([{ datallowconn: false }]);
    expect((await pools[0].query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [`${prefix}_template`])).rows[0].count).toBe(0);
    await manager.shutdown();
    expect(pools.every(pool => pool.ended)).toBe(true);
    const verification = new pg.Pool({ connectionString: liveUrl, max: 1, connectionTimeoutMillis: 2000, query_timeout: 5000 });
    try {
      expect((await verification.query('SELECT datname FROM pg_database WHERE starts_with(datname,$1)', [prefix])).rows).toEqual([]);
    } finally { await verification.end(); }
  }, 30_000);
});
