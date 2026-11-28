import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { ChatRepository } from '../../../../packages/gateway/src/chat/repository.js';
import { createGoogleContextStore } from '../../../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleModelHistoryStore } from '../../../../packages/gateway/src/google-data/runtime/model-history.js';
import { createGoogleModelHistoryReader } from '../../../../packages/gateway/src/google-data/runtime/model-history-reader.js';
import { createAuthorityFixture } from '../fixture-db.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const guarded = {};
const contextFence = 551035504;
const callbackBlocker = 551035505;
let repository: ChatRepository;
let clock: Date;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  // These regressions exercise driver queuing and transaction lifetime, not a WASM fallback.
  expect(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL).toBeTruthy();
  const { db } = await createAuthorityFixture();
  repository = new ChatRepository(db.sql);
  await repository.bootstrap();
  const history = createGoogleModelHistoryStore(repository.kysely);
  await history.migrate();
  repository = new ChatRepository(repository.kysely, false, undefined, {
    onServerCreatedEmptyChat: (tx, subject, id, receipt) => history.recordServerCreatedEmptyChat(tx, subject, id, receipt),
  });
  await repository.create(owner, { id: 'chat_source', clientRequestId: 'req_source', title: 'synthetic' });
  clock = new Date();
  await createGoogleContextStore(repository.kysely).mark({ ownerId: owner.ownerId, chatId: 'chat_source',
    googleAccountId: '10000000-0000-4000-8000-000000000001', consentId: 'consent_one', profileId: 'managed',
    profileRevision: 1, purposeId: 'assistant', expiresAt: new Date(clock.getTime() + 60_000).toISOString(),
    retentionDeadline: new Date(clock.getTime() + 60_000).toISOString() });
});

describe.runIf(Boolean(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL))('model history reader transaction lifetime', () => {
  it.each(['abort', 'retention-expiry'] as const)('withholds content after %s during the COMMIT-return window', async change => {
    const committed = deferred();
    const release = deferred();
    const transact = repository.withTransaction.bind(repository);
    vi.spyOn(repository, 'withTransaction').mockImplementation(async callback => {
      const value = await transact(callback); // The real PostgreSQL transaction has committed.
      committed.resolve();
      await release.promise;
      return value;
    });
    const control = new AbortController();
    const reader = createGoogleModelHistoryReader({ repository, isGuardedAdapter: value => value === guarded,
      now: () => clock });
    const result = reader.read({ owner, chatId: 'chat_source', adapter: guarded, signal: control.signal,
      read: async tx => (await tx.getDetailPage(owner, 'chat_source', { limit: 20 }))!.record.chat.title });
    const outcome = result.then(value => ({ value }), error => ({ error }));
    try {
      await committed.promise;
      if (change === 'abort') control.abort();
      else clock = new Date(clock.getTime() + 120_000);
    } finally { release.resolve(); }
    expect(await outcome).toEqual({ error: expect.objectContaining({ message: 'Chat context unavailable' }) });
  });

  it('drains queued callback SQL under the context fence before cancelled rollback releases the connection', async () => {
    await sql`CREATE TABLE model_reader_fence_observations(fenced BOOLEAN NOT NULL)`.execute(repository.kysely);
    const blockerReady = deferred();
    const unblock = deferred();
    const blocker = repository.kysely.connection().execute(async connection => {
      await sql`SELECT pg_advisory_lock(${callbackBlocker}::bigint)`.execute(connection);
      blockerReady.resolve();
      try { await unblock.promise; }
      finally { await sql`SELECT pg_advisory_unlock(${callbackBlocker}::bigint)`.execute(connection); }
    });
    await blockerReady.promise;
    const control = new AbortController();
    const callbackDone = deferred();
    let drained = false;
    let drainedAtRejection: boolean | undefined;
    const reader = createGoogleModelHistoryReader({ repository, isGuardedAdapter: value => value === guarded });
    const result = reader.read({ owner, chatId: 'chat_source', adapter: guarded, signal: control.signal,
      read: async tx => {
        try {
          // Kysely queues the second query behind the blocked first query on the same connection.
          const first = sql`SELECT pg_advisory_xact_lock(${callbackBlocker}::bigint)`.execute(tx.kysely);
          const second = sql`INSERT INTO model_reader_fence_observations(fenced) SELECT EXISTS(SELECT 1 FROM pg_locks
            WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=0
              AND objid=${contextFence}::oid AND granted)`.execute(tx.kysely);
          await Promise.all([first, second]);
          return 'synthetic-private';
        } finally { drained = true; callbackDone.resolve(); }
      } });
    const outcome = result.then(value => ({ value }), error => {
      drainedAtRejection = drained;
      return { error };
    });
    try {
      await vi.waitFor(async () => {
        const waiting = await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE locktype='advisory' AND objid=${callbackBlocker}::oid AND NOT granted) AS waiting`.execute(repository.kysely);
        expect(waiting.rows[0]!.waiting).toBe(true);
      }, { timeout: 2000 });
      control.abort();
      const fenced = await repository.kysely.transaction().execute(async tx =>
        (await sql<{ acquired: boolean }>`SELECT pg_try_advisory_xact_lock(${contextFence}::bigint) AS acquired`.execute(tx)).rows[0]!.acquired);
      expect(fenced).toBe(false);
    } finally {
      unblock.resolve();
      await blocker;
      await callbackDone.promise;
    }
    expect(await outcome).toEqual({ error: expect.objectContaining({ message: 'Chat context unavailable' }) });
    // The cancelled transaction rolls this synthetic observation back. If the
    // queued INSERT escapes rollback/release, it persists outside the transaction.
    expect((await sql`SELECT * FROM model_reader_fence_observations`.execute(repository.kysely)).rows).toHaveLength(0);
    expect(drainedAtRejection).toBe(true);
  });
});
