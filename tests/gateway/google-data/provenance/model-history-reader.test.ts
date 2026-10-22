import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ChatRepository } from '../../../../packages/gateway/src/chat/repository.js';
import { createGoogleContextStore } from '../../../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleModelHistoryStore } from '../../../../packages/gateway/src/google-data/runtime/model-history.js';
import { createGoogleModelHistoryReader } from '../../../../packages/gateway/src/google-data/runtime/model-history-reader.js';
import { createAuthorityFixture } from '../fixture-db.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const guarded = {}; const opaque = {};
let repository: ChatRepository;
let history: ReturnType<typeof createGoogleModelHistoryStore>;
let reader: ReturnType<typeof createGoogleModelHistoryReader>;
beforeEach(async () => {
  const { db } = await createAuthorityFixture();
  repository = new ChatRepository(db.sql); await repository.bootstrap();
  history = createGoogleModelHistoryStore(repository.kysely); await history.migrate();
  repository = new ChatRepository(repository.kysely, false, undefined, {
    onServerCreatedEmptyChat: (tx, subject, id, receipt) => history.recordServerCreatedEmptyChat(tx, subject, id, receipt),
  });
  for (const id of ['source', 'target']) await repository.create(owner, { id: `chat_${id}`, clientRequestId: `req_${id}`, title: id });
  reader = createGoogleModelHistoryReader({ repository, isGuardedAdapter: value => value === guarded });
});
async function mark() {
  await createGoogleContextStore(repository.kysely).mark({ ownerId: owner.ownerId, chatId: 'chat_source',
    googleAccountId: '10000000-0000-4000-8000-000000000001', consentId: 'consent_one', profileId: 'managed',
    profileRevision: 1, purposeId: 'assistant', expiresAt: new Date(Date.now() + 60000).toISOString(),
    retentionDeadline: new Date(Date.now() + 60000).toISOString() });
}
describe('transaction-bound model history reads', () => {
  it('reads through the same transaction and holds the purge fence through actual content loading', async () => {
    await mark();
    const value = await reader.read({ owner, chatId: 'chat_source', adapter: guarded,
      read: async tx => {
        expect(tx).not.toBe(repository); expect(tx.kysely.isTransaction).toBe(true);
        const settings = (await sql<{ statement: string; lock: string }>`SELECT current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock`.execute(tx.kysely)).rows[0];
        expect(settings).toEqual({ statement: '5s', lock: '2s' });
        const acquired = await repository.kysely.transaction().execute(async other =>
          (await sql<{ acquired: boolean }>`SELECT pg_try_advisory_xact_lock(551035504::bigint) AS acquired`.execute(other)).rows[0]!.acquired);
        expect(acquired).toBe(false);
        return (await tx.getDetailPage(owner, 'chat_source', { limit: 20 }))!.record.chat.title;
      } });
    expect(value).toBe('source');
    await repository.kysely.transaction().execute(async tx => {
      expect((await sql<{ acquired: boolean }>`SELECT pg_try_advisory_xact_lock(551035504::bigint) AS acquired`.execute(tx)).rows[0]!.acquired).toBe(true);
    });
  });
  it('inherits before a reference read and rolls the marker back when loading fails', async () => {
    await mark();
    await expect(reader.read({ owner, chatId: 'chat_source', targetChatId: 'chat_target', read: async tx => {
      expect((await createGoogleModelHistoryStore(tx.kysely).inspect(owner, 'chat_target')).classification).toBe('google');
      throw new Error('private failure');
    } })).rejects.toThrow('Chat context unavailable');
    expect(await history.inspect(owner, 'chat_target')).toEqual({ classification: 'ordinary' });
  });
  it('commits inherited lineage before releasing reference text', async () => {
    await mark();
    expect(await reader.read({ owner, chatId: 'chat_source', targetChatId: 'chat_target', read: async tx =>
      (await tx.getDetailPage(owner, 'chat_source', { limit: 20 }))!.record.chat.title })).toBe('source');
    expect((await history.inspect(owner, 'chat_target')).classification).toBe('google');
    await expect(reader.assertRun({ owner, chatId: 'chat_target', adapter: opaque })).rejects.toThrow('Chat context unavailable');
    await expect(reader.assertRun({ owner, chatId: 'chat_target', adapter: guarded })).resolves.toBeUndefined();
  });
  it('keeps owner inspection available while refusing unknown history for model use', async () => {
    await new ChatRepository(repository.kysely).create(owner, { id: 'chat_old', clientRequestId: 'req_old', title: 'old' });
    expect(await repository.getDetailPage(owner, 'chat_old', { limit: 20 })).not.toBeNull();
    let called = false;
    await expect(reader.read({ owner, chatId: 'chat_old', adapter: guarded, read: async () => { called = true; return 'private'; } })).rejects.toThrow();
    expect(called).toBe(false);
  });
  it('supports a caller transaction and rolls lineage back with the surrounding operation', async () => {
    await mark();
    await expect(repository.withTransaction(async tx => {
      const joined = createGoogleModelHistoryReader({ repository: tx, isGuardedAdapter: value => value === guarded });
      await joined.read({ owner, chatId: 'chat_source', targetChatId: 'chat_target', read: async () => 'private' });
      throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    expect(await history.inspect(owner, 'chat_target')).toEqual({ classification: 'ordinary' });
    await repository.getDetailPage(owner, 'chat_source', { limit: 20 });
  });
  it('refuses a cancelled operation before reading or inheriting', async () => {
    await mark(); const control = new AbortController(); control.abort(); let called = false;
    await expect(reader.read({ owner, chatId: 'chat_source', targetChatId: 'chat_target', signal: control.signal,
      read: async () => { called = true; return 'private'; } })).rejects.toThrow('Chat context unavailable');
    expect(called).toBe(false); expect(await history.inspect(owner, 'chat_target')).toEqual({ classification: 'ordinary' });
  });
});
