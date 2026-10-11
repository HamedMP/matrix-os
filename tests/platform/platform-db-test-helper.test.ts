import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestPlatformDb } from './platform-db-test-helper.js';

const databases: TestPlatformDb[] = [];

beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { db } of databases.splice(0)) await db.destroy();
});

async function fixture(options?: { freshSchema?: boolean }) {
  const helper = await import('./platform-db-test-helper.js');
  const result = await helper.createTestPlatformDb(options);
  databases.push(result);
  return result;
}

describe('fresh platform test database snapshots', () => {
  it('migrates and closes one template, then restores independent engines and still bootstraps each', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const dbModule = await import('../../packages/platform/src/db.js');
    const create = vi.spyOn(KyselyPGlite, 'create');
    const bootstrap = vi.spyOn(dbModule, 'createPlatformDb');
    const first = await fixture();
    const second = await fixture();
    expect(create).toHaveBeenCalledTimes(3);
    expect(bootstrap).toHaveBeenCalledTimes(3);
    const template = await create.mock.results[0].value;
    expect(template.client.closed).toBe(true);
    // Vitest infers the final string overload; actual calls use the options overload.
    const firstOptions = create.mock.calls[1][0] as unknown as { loadDataDir: Blob };
    const secondOptions = create.mock.calls[2][0] as unknown as { loadDataDir: Blob };
    expect(firstOptions.loadDataDir).toBeInstanceOf(Blob);
    expect(secondOptions.loadDataDir).toBe(firstOptions.loadDataDir);
    expect(first.instance.client).not.toBe(second.instance.client);
    expect(first.instance.client.closed).toBe(false);
    expect(second.instance.client.closed).toBe(false);
  });

  it('shares only immutable initialization across concurrent calls; data, schema, and sequences remain isolated', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const create = vi.spyOn(KyselyPGlite, 'create');
    const [first, second] = await Promise.all([fixture(), fixture()]);
    expect(create).toHaveBeenCalledTimes(3);
    await sql`UPDATE ai_funded_global_policy SET revision = 9`.execute(first.db.kysely);
    expect((await sql<{ revision: number }>`SELECT revision FROM ai_funded_global_policy`.execute(second.db.kysely)).rows[0].revision).toBe(0);
    const nextSequence = async (database: TestPlatformDb) => String((await sql<{ value: number }>`SELECT nextval(pg_get_serial_sequence('whatsapp_jobs', 'sequence')) AS value`.execute(database.db.kysely)).rows[0].value);
    expect(await nextSequence(first)).toBe('1');
    expect(await nextSequence(first)).toBe('2');
    expect(await nextSequence(second)).toBe('1');
    await sql`CREATE TABLE fixture_isolation (id SERIAL PRIMARY KEY, value TEXT UNIQUE NOT NULL)`.execute(first.db.kysely);
    await sql`CREATE TABLE fixture_isolation (id SERIAL PRIMARY KEY, value TEXT UNIQUE NOT NULL)`.execute(second.db.kysely);
    await sql`INSERT INTO fixture_isolation(value) VALUES ('same_value'), ('first_only')`.execute(first.db.kysely);
    await sql`INSERT INTO fixture_isolation(value) VALUES ('same_value')`.execute(second.db.kysely);
    expect((await sql<{ id: number; value: string }>`SELECT id, value FROM fixture_isolation ORDER BY id`.execute(first.db.kysely)).rows)
      .toEqual([{ id: 1, value: 'same_value' }, { id: 2, value: 'first_only' }]);
    expect((await sql<{ id: number; value: string }>`SELECT id, value FROM fixture_isolation ORDER BY id`.execute(second.db.kysely)).rows)
      .toEqual([{ id: 1, value: 'same_value' }]);
    const third = await fixture();
    expect(await nextSequence(third)).toBe('1');
    expect((await sql<{ revision: number }>`SELECT revision FROM ai_funded_global_policy`.execute(third.db.kysely)).rows[0].revision).toBe(0);
    expect((await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_name = 'fixture_isolation'`.execute(third.db.kysely)).rows).toEqual([]);
  });

  it('preserves migrated defaults, constraints, revision markers, and baseline seed data', async () => {
    const { db } = await fixture();
    const seed = await sql<{ policy_id: string; enabled: boolean; revision: number }>`SELECT policy_id, enabled, revision FROM ai_funded_global_policy`.execute(db.kysely);
    expect(seed.rows).toEqual([{ policy_id: 'default', enabled: false, revision: 0 }]);
    const revisions = await sql<{ scope: string }>`SELECT scope FROM platform_schema_revisions ORDER BY scope`.execute(db.kysely);
    expect(revisions.rows.map(row => row.scope)).toEqual(['core', 'whatsapp']);
    const insert = await sql<{ id: string; plan: string; status: string }>`INSERT INTO users (clerk_id, handle, display_name, email, container_id)
      VALUES ('fixture_user', 'fixture_user', 'Fixture', 'fixture@example.test', 'fixture_container') RETURNING id, plan, status`.execute(db.kysely);
    expect(insert.rows[0]).toMatchObject({ id: expect.any(String), plan: 'free', status: 'active' });
    await expect(sql`INSERT INTO users (clerk_id, handle, display_name, email, container_id)
      VALUES ('fixture_user', 'another_handle', 'Fixture', 'other@example.test', 'another_container')`.execute(db.kysely)).rejects.toMatchObject({ code: '23505' });
    await expect(sql`INSERT INTO ai_funded_global_policy (policy_id, enabled, allowed_model_ids, revision, updated_at)
      VALUES ('invalid', false, '[]', -1, 'now')`.execute(db.kysely)).rejects.toMatchObject({ code: '23514' });
  });

  it('explicit freshSchema mode creates uncached engines and runs the full unchanged startup', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const dbModule = await import('../../packages/platform/src/db.js');
    const create = vi.spyOn(KyselyPGlite, 'create');
    const bootstrap = vi.spyOn(dbModule, 'createPlatformDb');
    const first = await fixture({ freshSchema: true });
    const second = await fixture({ freshSchema: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every(args => args[0] === undefined)).toBe(true);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(first.instance.client).not.toBe(second.instance.client);
    expect((await sql`SELECT * FROM platform_schema_revisions`.execute(second.db.kysely)).rows).toHaveLength(2);
    await fixture();
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('closes a template on dump failure and retries initialization on the next call', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const original = KyselyPGlite.create.bind(KyselyPGlite);
    let failedTemplate: Awaited<ReturnType<typeof KyselyPGlite.create>> | undefined;
    const error = new Error('synthetic snapshot failure');
    vi.spyOn(KyselyPGlite, 'create').mockImplementationOnce(async () => {
      failedTemplate = await original();
      vi.spyOn(failedTemplate.client, 'dumpDataDir').mockRejectedValueOnce(error);
      return failedTemplate;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toBe(error);
    expect(failedTemplate?.client.closed).toBe(true);
    await expect(fixture()).resolves.toBeDefined();
  });

  it('closes a template on bootstrap failure and permits a clean retry', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const dbModule = await import('../../packages/platform/src/db.js');
    const original = dbModule.createPlatformDb;
    const create = vi.spyOn(KyselyPGlite, 'create');
    const error = new Error('synthetic startup failure');
    vi.spyOn(dbModule, 'createPlatformDb').mockImplementationOnce(options => {
      const db = original(options);
      db.ready = db.ready.then(() => { throw error; });
      return db;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toBe(error);
    expect((await create.mock.results[0].value).client.closed).toBe(true);
    await expect(fixture()).resolves.toBeDefined();
  });

  it('closes a failed restored engine without discarding the immutable baseline', async () => {
    await fixture();
    const { KyselyPGlite } = await import('kysely-pglite');
    const dbModule = await import('../../packages/platform/src/db.js');
    const original = dbModule.createPlatformDb;
    const create = vi.spyOn(KyselyPGlite, 'create');
    const error = new Error('synthetic restored startup failure');
    vi.spyOn(dbModule, 'createPlatformDb').mockImplementationOnce(options => {
      const db = original(options);
      db.ready = db.ready.then(() => { throw error; });
      return db;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toBe(error);
    expect((await create.mock.results[0].value).client.closed).toBe(true);
    await fixture();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('bounds the retained snapshot and closes oversized templates', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const original = KyselyPGlite.create.bind(KyselyPGlite);
    let template: Awaited<ReturnType<typeof KyselyPGlite.create>> | undefined;
    vi.spyOn(KyselyPGlite, 'create').mockImplementationOnce(async () => {
      template = await original();
      const oversized = new Blob();
      Object.defineProperty(oversized, 'size', { value: 64 * 1024 * 1024 + 1 });
      vi.spyOn(template.client, 'dumpDataDir').mockResolvedValueOnce(oversized);
      return template;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toThrow(/snapshot.*limit/i);
    expect(template?.client.closed).toBe(true);
    await expect(fixture()).resolves.toBeDefined();
  });

  it('preserves both snapshot and cleanup failures instead of masking the original', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const dbModule = await import('../../packages/platform/src/db.js');
    const originalCreate = KyselyPGlite.create.bind(KyselyPGlite);
    const originalDb = dbModule.createPlatformDb;
    const dumpError = new Error('synthetic dump failure');
    const cleanupError = new Error('synthetic cleanup failure');
    let template: Awaited<ReturnType<typeof KyselyPGlite.create>> | undefined;
    vi.spyOn(KyselyPGlite, 'create').mockImplementationOnce(async () => {
      template = await originalCreate();
      vi.spyOn(template.client, 'dumpDataDir').mockRejectedValueOnce(dumpError);
      return template;
    });
    vi.spyOn(dbModule, 'createPlatformDb').mockImplementationOnce(options => {
      const db = originalDb(options);
      const destroy = db.destroy.bind(db);
      db.destroy = async () => { await destroy(); throw cleanupError; };
      return db;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toMatchObject({ errors: [dumpError, cleanupError] });
    expect(template?.client.closed).toBe(true);
    await expect(fixture()).resolves.toBeDefined();
  });
});
