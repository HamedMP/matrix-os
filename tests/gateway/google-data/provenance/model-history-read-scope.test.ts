import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, sql, type Dialect } from 'kysely';
import pg from 'pg';
import { ChatRepository } from '../../../../packages/gateway/src/chat/repository.js';
import { createGoogleModelHistoryStore } from '../../../../packages/gateway/src/google-data/runtime/model-history.js';
import { createGoogleModelHistoryReader } from '../../../../packages/gateway/src/google-data/runtime/model-history-reader.js';
import { createNativeFixtureManager } from '../../../platform/native-platform-db-test-helper.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
let trace: string[] = [];
const manager = createNativeFixtureManager({
  createPool: config => new pg.Pool({ ...config, max: 10 }),
  createDb: ({ dialect }) => {
    const db = new Kysely<any>({ dialect: dialect as Dialect, log: event => {
      // Observe actual driver completion, including errors, without replacing transport.
      if (/read_scope_|^rollback$/i.test(event.query.sql)) trace.push(event.query.sql);
    } });
    return { db, ready: Promise.resolve(), destroy: () => db.destroy() };
  },
  createFallback: async () => { throw new Error('Native PostgreSQL fixture is required'); },
  destroyFallback: fixture => fixture.destroy(),
});
afterEach(() => manager.drainClones(), 60_000);
afterAll(() => manager.shutdown(), 120_000);

let repository: ChatRepository;
beforeEach(async () => {
  expect(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL).toBeTruthy();
  const { db: fixture } = await manager.createTestPlatformDb();
  repository = new ChatRepository(fixture.db);
  await repository.bootstrap();
  const history = createGoogleModelHistoryStore(repository.kysely);
  await history.migrate();
  repository = new ChatRepository(repository.kysely, false, undefined, {
    onServerCreatedEmptyChat: (tx, subject, id, receipt) => history.recordServerCreatedEmptyChat(tx, subject, id, receipt),
  });
  await repository.create(owner, { id: 'chat_source', clientRequestId: 'req_source', title: 'synthetic' });
  trace = [];
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// This scope protects trusted, finite normal query-builder reads. It does not
// qualify arbitrary callbacks, precompiled executeQuery, plugin removal or streams.
describe.runIf(Boolean(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL))('model history finite database read scope', () => {
  it('drains siblings after Promise.all rejects before rolling back an aborted transaction', async () => {
    const reader = createGoogleModelHistoryReader({ repository, isGuardedAdapter: () => false });
    let siblings: Promise<unknown>[] = [];
    try {
      await expect(reader.read({ owner, chatId: 'chat_source', read: async tx => {
        siblings = [
          sql`SELECT 1 / 0 AS read_scope_failure`.execute(tx.kysely),
          sql`SELECT 2 AS read_scope_queued_two`.execute(tx.kysely),
          sql`SELECT 3 AS read_scope_queued_three`.execute(tx.kysely),
        ];
        await Promise.all(siblings);
        return 'synthetic-private';
      } })).rejects.toThrow('Chat context unavailable');
    } finally { await Promise.allSettled(siblings); }
    const rollback = trace.findIndex(query => /^rollback$/i.test(query));
    expect(rollback).toBeGreaterThanOrEqual(0);
    for (const name of ['read_scope_failure', 'read_scope_queued_two', 'read_scope_queued_three']) {
      const completed = trace.findIndex(query => query.includes(name));
      expect(completed, `${name} must reach the real driver`).toBeGreaterThanOrEqual(0);
      expect(completed, `${name} must settle before rollback`).toBeLessThan(rollback);
    }
  });

  it('denies a late normal builder before driver dispatch once its callback scope closes', async () => {
    const scopeClosed = deferred();
    const release = deferred();
    const transact = repository.withTransaction.bind(repository);
    // Pause after the reader's transaction body settles but before PostgreSQL COMMIT.
    vi.spyOn(repository, 'withTransaction').mockImplementation(callback => transact(async tx => {
      const value = await callback(tx);
      scopeClosed.resolve();
      await release.promise;
      return value;
    }));
    let callbackRepository: ChatRepository | undefined;
    const reader = createGoogleModelHistoryReader({ repository, isGuardedAdapter: () => false });
    const work = reader.read({ owner, chatId: 'chat_source', read: async tx => {
      callbackRepository = tx;
      return (await tx.getDetailPage(owner, 'chat_source', { limit: 20 }))!.record.chat.title;
    } });
    const outcome = work.then(value => ({ value }), error => ({ error }));
    try {
      await scopeClosed.promise;
      expect(callbackRepository).toBeDefined();
      const late = callbackRepository!.kysely.selectNoFrom(sql<number>`1`.as('read_scope_late')).execute();
      await expect(late).rejects.toThrow('Chat context unavailable');
      expect(trace.some(query => query.includes('read_scope_late'))).toBe(false);
    } finally {
      release.resolve();
      await outcome;
    }
    expect(await outcome).toEqual({ value: 'synthetic' });
  });
});
