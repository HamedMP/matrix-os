import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KyselyPGlite } from 'kysely-pglite';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';

type Engine = InstanceType<typeof KyselyPGlite>;
const engines: Engine[] = [];
beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) if (!engine.client.closed) await engine.client.close();
});
async function fixture(): Promise<Engine> {
  const { createTestPGlite } = await import('./pglite-test-helper.js');
  const engine = await createTestPGlite();
  engines.push(engine);
  return engine;
}
async function publicTables(engine: Engine) {
  return (await engine.client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
}

describe('empty initialized PostgreSQL test snapshots', () => {
  it('coalesces and closes one empty template; concurrent engines isolate schema, rows, and sequences', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const create = vi.spyOn(KyselyPGlite, 'create');
    const [first, second] = await Promise.all([fixture(), fixture()]);
    expect(create).toHaveBeenCalledTimes(3);
    const template = await create.mock.results[0].value;
    expect(template.client.closed).toBe(true);
    const options = create.mock.calls.slice(1).map(args => args[0] as unknown as { loadDataDir: Blob });
    expect(options[0].loadDataDir).toBeInstanceOf(Blob);
    expect(options[0].loadDataDir.size).toBeGreaterThan(0);
    expect(options[0].loadDataDir.size).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(options[1].loadDataDir).toBe(options[0].loadDataDir);
    expect(first.client).not.toBe(second.client);
    expect(await publicTables(first)).toEqual([]);
    expect(await publicTables(second)).toEqual([]);
    for (const engine of [first, second]) {
      await engine.client.exec('CREATE TABLE isolation (id SERIAL PRIMARY KEY, value TEXT UNIQUE NOT NULL)');
      await engine.client.exec("INSERT INTO isolation(value) VALUES ('same')");
    }
    await first.client.exec("INSERT INTO isolation(value) VALUES ('first_only')");
    expect((await first.client.query('SELECT id, value FROM isolation ORDER BY id')).rows)
      .toEqual([{ id: 1, value: 'same' }, { id: 2, value: 'first_only' }]);
    expect((await second.client.query('SELECT id, value FROM isolation ORDER BY id')).rows)
      .toEqual([{ id: 1, value: 'same' }]);
    expect(await publicTables(await fixture())).toEqual([]);
  });

  it('runs normal Chat bootstrap from an empty schema and preserves schema, constraints, indexes, and defaults', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const raw = await KyselyPGlite.create();
    engines.push(raw);
    const restored = await fixture();
    const schemaQuery = `SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`;
    const indexesQuery = "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname";
    const constraintsQuery = `SELECT table_name, constraint_name, constraint_type FROM information_schema.table_constraints
      WHERE table_schema = 'public' ORDER BY table_name, constraint_name`;
    const owner = { type: 'personal' as const, ownerId: 'snapshot_contract' };
    for (const engine of [raw, restored]) {
      expect(await publicTables(engine)).toEqual([]);
      const repository = new ChatRepository(engine.dialect);
      await repository.bootstrap();
      await repository.bootstrap();
      await repository.create(owner, { id: 'chat_contract', clientRequestId: 'req_contract', title: 'Snapshot contract' });
      expect((await repository.get(owner, 'chat_contract'))?.chat.title).toBe('Snapshot contract');
      expect((await engine.client.query('SELECT cursor FROM chat_outbox ORDER BY cursor')).rows)
        .toEqual([{ cursor: 1 }]);
    }
    for (const query of [schemaQuery, indexesQuery, constraintsQuery]) {
      const expected = (await raw.client.query(query)).rows;
      expect(expected.length).toBeGreaterThan(0);
      expect((await restored.client.query(query)).rows).toEqual(expected);
    }
    const defaultsQuery = 'SELECT lifecycle, attention, revision, message_count, title_manual FROM chats WHERE id = \'chat_contract\'';
    const expectedDefaults = [{ lifecycle: 'active', attention: 'none', revision: 0, message_count: 0, title_manual: false }];
    expect((await raw.client.query(defaultsQuery)).rows).toEqual(expectedDefaults);
    expect((await restored.client.query(defaultsQuery)).rows).toEqual(expectedDefaults);
    expect(await publicTables(await fixture())).toEqual([]);
  });

  it('clears rejected initialization for retry and rejects all concurrent waiters', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const error = new Error('synthetic initialization failure');
    const create = vi.spyOn(KyselyPGlite, 'create').mockRejectedValueOnce(error);
    const results = await Promise.allSettled([fixture().then(() => 'resolved'), fixture().then(() => 'resolved')]);
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await publicTables(await fixture())).toEqual([]);
  });

  it('closes a template after dump failure, logs the failure, and retries', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const original = KyselyPGlite.create.bind(KyselyPGlite);
    const error = new Error('synthetic dump failure');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let template: Engine | undefined;
    vi.spyOn(KyselyPGlite, 'create').mockImplementationOnce(async () => {
      template = await original();
      vi.spyOn(template.client, 'dumpDataDir').mockRejectedValueOnce(error);
      return template;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toBe(error);
    expect(template?.client.closed).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/snapshot/i), error.message);
    expect(await publicTables(await fixture())).toEqual([]);
  });

  it('rejects oversized images, closes the template, and retries without publishing it', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const original = KyselyPGlite.create.bind(KyselyPGlite);
    let template: Engine | undefined;
    vi.spyOn(KyselyPGlite, 'create').mockImplementationOnce(async () => {
      template = await original();
      const oversized = new Blob();
      Object.defineProperty(oversized, 'size', { value: 64 * 1024 * 1024 + 1 });
      vi.spyOn(template.client, 'dumpDataDir').mockResolvedValueOnce(oversized);
      return template;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toThrow(/64 MiB/);
    expect(template?.client.closed).toBe(true);
    expect(await publicTables(await fixture())).toEqual([]);
  });

  it('preserves and logs both dump and cleanup failures', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const original = KyselyPGlite.create.bind(KyselyPGlite);
    const dumpError = new Error('synthetic dump failure');
    const cleanupError = new Error('synthetic cleanup failure');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let template: Engine | undefined;
    vi.spyOn(KyselyPGlite, 'create').mockImplementationOnce(async () => {
      template = await original();
      vi.spyOn(template.client, 'dumpDataDir').mockRejectedValueOnce(dumpError);
      const close = template.client.close.bind(template.client);
      vi.spyOn(template.client, 'close').mockImplementationOnce(async () => { await close(); throw cleanupError; });
      return template;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toMatchObject({ errors: [dumpError, cleanupError] });
    expect(template?.client.closed).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/snapshot/i), dumpError.message);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/cleanup/i), cleanupError.message);
    expect(await publicTables(await fixture())).toEqual([]);
  });

  it('publishes no snapshot if template closure fails', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const original = KyselyPGlite.create.bind(KyselyPGlite);
    const error = new Error('synthetic close failure');
    const create = vi.spyOn(KyselyPGlite, 'create').mockImplementationOnce(async () => {
      const template = await original();
      const close = template.client.close.bind(template.client);
      vi.spyOn(template.client, 'close').mockImplementationOnce(async () => { await close(); throw error; });
      return template;
    });
    await expect(fixture().then(() => 'resolved')).rejects.toBe(error);
    expect((await create.mock.results[0].value).client.closed).toBe(true);
    expect(await publicTables(await fixture())).toEqual([]);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('retains the immutable image when one restored engine fails to initialize', async () => {
    await fixture();
    const { KyselyPGlite } = await import('kysely-pglite');
    const error = new Error('synthetic restore failure');
    const create = vi.spyOn(KyselyPGlite, 'create').mockRejectedValueOnce(error);
    await expect(fixture().then(() => 'resolved')).rejects.toBe(error);
    expect(await publicTables(await fixture())).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every(args => args[0] !== undefined)).toBe(true);
  });
});
