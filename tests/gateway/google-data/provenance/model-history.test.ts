import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { CodexChatImporter } from '../../../../packages/gateway/src/chat/codex-importer.js';
import { ChatRepository } from '../../../../packages/gateway/src/chat/repository.js';
import { createGoogleContextStore, type GoogleContextMark } from '../../../../packages/gateway/src/google-data/runtime/contexts.js';
import { boundedProvenanceTransaction } from '../../../../packages/gateway/src/google-data/provenance/transaction.js';
import { createGoogleModelHistoryStore } from '../../../../packages/gateway/src/google-data/runtime/model-history.js';
import { createAuthorityFixture } from '../fixture-db.js';
import type { ChatOwner } from '../../../../packages/gateway/src/chat/records.js';

const owner: ChatOwner = { type: 'personal', ownerId: 'owner_one' };
const outsider: ChatOwner = { type: 'personal', ownerId: 'owner_two' };
const account = '10000000-0000-4000-8000-000000000001';
const otherAccount = '10000000-0000-4000-8000-000000000002';
const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
const input = (suffix: string) => ({ id: `chat_${suffix}`, clientRequestId: `req_${suffix}`, title: 'New chat' });
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
let repository: ChatRepository;
let history: ReturnType<typeof createGoogleModelHistoryStore>;
let contexts: ReturnType<typeof createGoogleContextStore>;
const mark = (chatId: string, extra: Partial<GoogleContextMark> = {}): GoogleContextMark => ({ ownerId: owner.ownerId,
  chatId, googleAccountId: account, consentId: 'consent_one', profileId: 'managed', profileRevision: 1,
  purposeId: 'assistant', expiresAt: future(), retentionDeadline: future(), ...extra });

beforeEach(async () => {
  ({ db } = await createAuthorityFixture());
  repository = new ChatRepository(db.sql);
  await repository.bootstrap();
  history = createGoogleModelHistoryStore(repository.kysely);
  await history.migrate();
  contexts = createGoogleContextStore(repository.kysely);
  repository = new ChatRepository(repository.kysely, false, undefined, {
    onServerCreatedEmptyChat: (tx, subject, chatId, receipt) => history.recordServerCreatedEmptyChat(tx, subject, chatId, receipt),
  });
});

describe('authoritative model-history classification', () => {
  it('only classifies a newly server-created empty chat and persists across reopening', async () => {
    await repository.create(owner, input('new'));
    expect(await history.inspect(owner, 'chat_new')).toEqual({ classification: 'ordinary' });
    expect(await createGoogleModelHistoryStore(repository.kysely).inspect(owner, 'chat_new')).toEqual({ classification: 'ordinary' });
    expect(await history.inspect(outsider, 'chat_new')).toEqual({ classification: 'unknown' });
    expect(await history.inspect(owner, 'chat_missing')).toEqual({ classification: 'unknown' });
  });
  it('does not backfill an existing empty chat when the create request is replayed', async () => {
    const legacy = new ChatRepository(repository.kysely);
    await legacy.create(owner, input('old'));
    await repository.create(owner, { ...input('old'), id: 'chat_replayed' });
    expect(await history.inspect(owner, 'chat_old')).toEqual({ classification: 'unknown' });
    await expect(repository.kysely.transaction().execute(tx => history.recordServerCreatedEmptyChat(tx, owner, 'chat_old', {} as never))).rejects.toThrow();
    expect(await history.inspect(owner, 'chat_old')).toEqual({ classification: 'unknown' });
  });
  it('cannot promote an old row updated inside the current transaction using a forged insert receipt', async () => {
    await new ChatRepository(repository.kysely).create(owner, input('updated_old'));
    await expect(repository.kysely.transaction().execute(async tx => {
      await sql`UPDATE chats SET title='updated' WHERE id='chat_updated_old'`.execute(tx);
      await history.recordServerCreatedEmptyChat(tx, owner, 'chat_updated_old', {} as never);
    })).rejects.toThrow();
    expect(await history.inspect(owner, 'chat_updated_old')).toEqual({ classification: 'unknown' });
  });
  it('invalidates an unused insert receipt as soon as its callback settles', async () => {
    let captured: Parameters<typeof history.recordServerCreatedEmptyChat>[3];
    const captureOnly = new ChatRepository(repository.kysely, false, undefined, {
      onServerCreatedEmptyChat: async (_tx, _subject, _chatId, receipt) => { captured = receipt; },
    });
    await captureOnly.create(owner, input('captured'));
    await expect(repository.kysely.transaction().execute(async tx => {
      await sql`UPDATE chats SET title='changed' WHERE id='chat_captured'`.execute(tx);
      await history.recordServerCreatedEmptyChat(tx, owner, 'chat_captured', captured!);
    })).rejects.toThrow();
    expect(await history.inspect(owner, 'chat_captured')).toEqual({ classification: 'unknown' });
  });
  it('binds the insert receipt to its exact owner, chat and live transaction', async () => {
    const guarded = new ChatRepository(repository.kysely, false, undefined, {
      onServerCreatedEmptyChat: async (tx, subject, chatId, receipt) => {
        await expect(history.recordServerCreatedEmptyChat(tx, outsider, chatId, receipt)).rejects.toThrow();
        await expect(history.recordServerCreatedEmptyChat(tx, subject, 'chat_other', receipt)).rejects.toThrow();
        await expect(history.recordServerCreatedEmptyChat(repository.kysely, subject, chatId, receipt)).rejects.toThrow();
        await history.recordServerCreatedEmptyChat(tx, subject, chatId, receipt);
        await expect(history.recordServerCreatedEmptyChat(tx, subject, chatId, receipt)).rejects.toThrow();
      },
    });
    await guarded.create(owner, input('receipt'));
    expect(await history.inspect(owner, 'chat_receipt')).toEqual({ classification: 'ordinary' });
  });
  it('keeps actually published imports unknown without scanning their apparently ordinary text', async () => {
    const importer = new CodexChatImporter(repository);
    const sourceId = randomUUID();
    await importer.begin(owner, { sourceId, sourceHash: 'a'.repeat(64), title: 'Imported chat' });
    await importer.append(owner, sourceId, { startSeq: 1, messages: [
      { role: 'user', text: 'Hello', createdAt: new Date().toISOString() },
      { role: 'assistant', text: 'Ordinary-looking content', createdAt: new Date().toISOString() },
    ] });
    const published = await importer.complete(owner, sourceId, { messageCount: 2 });
    expect(await history.inspect(owner, published.chatId)).toEqual({ classification: 'unknown' });
    expect((await repository.getDetailPage(owner, published.chatId, { limit: 20 }))?.messages).toHaveLength(2);
  });
  it('does not turn a preexisting Google marker into complete historical classification', async () => {
    await new ChatRepository(repository.kysely).create(owner, input('old'));
    await contexts.mark(mark('chat_old'));
    expect(await history.inspect(owner, 'chat_old')).toMatchObject({ classification: 'unknown', googleContext: { availability: 'available' } });
  });
  it('rolls back creation and birth together and preserves the hook inside outer transactions', async () => {
    await expect(repository.withTransaction(async tx => {
      await tx.create(owner, input('rollback'));
      expect(await createGoogleModelHistoryStore(tx.kysely).inspect(owner, 'chat_rollback')).toEqual({ classification: 'ordinary' });
      throw new Error('cancel');
    })).rejects.toThrow('cancel');
    expect(await repository.get(owner, 'chat_rollback')).toBeNull();
    expect(await history.inspect(owner, 'chat_rollback')).toEqual({ classification: 'unknown' });
    await repository.withTransaction(tx => tx.create(owner, input('committed')));
    expect(await history.inspect(owner, 'chat_committed')).toEqual({ classification: 'ordinary' });
  });
  it('concurrent request replay creates exactly one birth for the actual inserted chat', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => repository.create(owner, {
      ...input(`concurrent_${index}`), clientRequestId: 'req_concurrent',
    })));
    expect(new Set(results.map(result => result.chat.id)).size).toBe(1);
    expect((await sql`SELECT 1 FROM google_model_history_births`.execute(repository.kysely)).rows).toHaveLength(1);
    expect(await history.inspect(owner, results[0]!.chat.id)).toEqual({ classification: 'ordinary' });
  });
  it('rolls back all chat writes if classification capacity is exhausted', async () => {
    const capped = createGoogleModelHistoryStore(repository.kysely, { maxBirthsPerOwner: 1 });
    const repo = new ChatRepository(repository.kysely, false, undefined, {
      onServerCreatedEmptyChat: (tx, subject, chatId, receipt) => capped.recordServerCreatedEmptyChat(tx, subject, chatId, receipt),
    });
    await repo.create(owner, input('first'));
    await expect(repo.create(owner, input('second'))).rejects.toThrow();
    expect(await repo.get(owner, 'chat_second')).toBeNull();
    expect((await sql`SELECT 1 FROM chat_outbox WHERE chat_id='chat_second'`.execute(repository.kysely)).rows).toHaveLength(0);
    await repo.create(outsider, input('other_owner'));
  });
  it('does not classify organization ownership using a matching personal owner id', async () => {
    const organization: ChatOwner = { type: 'organization', ownerId: owner.ownerId };
    await repository.create(organization, input('organization'));
    await contexts.mark(mark('chat_organization'));
    expect(await history.inspect(organization, 'chat_organization')).toEqual({ classification: 'unknown' });
    expect(await history.inspect(owner, 'chat_organization')).toEqual({ classification: 'unknown' });
  });
  it('joins Google inheritance to the caller content transaction without nested transactions', async () => {
    for (const name of ['source_a', 'source_b', 'target']) await repository.create(owner, input(name));
    const deadline = future(20_000);
    await contexts.mark(mark('chat_source_a', { retentionDeadline: deadline }));
    await contexts.mark(mark('chat_source_b', { googleAccountId: otherAccount, consentId: 'second' }));
    await expect(repository.kysely.transaction().execute(async tx => {
      const joined = createGoogleModelHistoryStore(tx);
      expect((await joined.inherit(owner, 'chat_target', ['chat_source_a', 'chat_source_b'])).classification).toBe('google');
      await sql`UPDATE chats SET title='copied content' WHERE id='chat_target'`.execute(tx);
      throw new Error('rollback copy');
    })).rejects.toThrow('rollback copy');
    expect(await history.inspect(owner, 'chat_target')).toEqual({ classification: 'ordinary' });
    const inherited = await history.inherit(owner, 'chat_target', ['chat_source_a', 'chat_source_b']);
    expect(inherited).toMatchObject({ classification: 'google', googleContext: { retentionDeadline: deadline, sources: expect.any(Array) } });
    if (inherited.classification !== 'google') throw new Error('Expected Google');
    expect(inherited.googleContext.sources).toHaveLength(2);
    await expect(history.inherit(owner, 'chat_target', ['chat_source_a'])).rejects.toThrow();
    expect((await history.inherit(owner, 'chat_target', ['chat_source_a'], inherited.googleContext.revision))).toMatchObject({ classification: 'google' });
  });
  it('denies unknown source or target, cross-owner history, and leaves no partial lineage', async () => {
    await repository.create(owner, input('target'));
    await new ChatRepository(repository.kysely).create(owner, input('unknown'));
    await repository.create(outsider, input('foreign'));
    for (const source of ['chat_unknown', 'chat_foreign', 'chat_missing']) {
      await expect(history.inherit(owner, 'chat_target', [source])).rejects.toThrow();
    }
    await expect(history.inherit(owner, 'chat_unknown', ['chat_target'])).rejects.toThrow();
    expect(await contexts.inspect(owner.ownerId, 'chat_target')).toBeNull();
  });
  it('retains closed markers over birth and cannot revive them with an ordinary reference', async () => {
    for (const name of ['google', 'ordinary', 'target']) await repository.create(owner, input(name));
    await contexts.mark(mark('chat_google'));
    await history.inherit(owner, 'chat_target', ['chat_google']);
    await contexts.beginPurge(owner.ownerId, account);
    expect(await history.inspect(owner, 'chat_target')).toMatchObject({ classification: 'google', googleContext: { availability: 'purging' } });
    await expect(history.inherit(owner, 'chat_target', ['chat_ordinary'], 2)).rejects.toThrow();
    await expect(history.inherit(owner, 'chat_ordinary', ['chat_google'])).rejects.toThrow();
  });
  it('denies source expiry while retaining its Google classification', async () => {
    let now = new Date();
    history = createGoogleModelHistoryStore(repository.kysely, { now: () => now });
    for (const name of ['expires', 'target']) await repository.create(owner, input(name));
    await contexts.mark(mark('chat_expires', { expiresAt: future(1000) }));
    now = new Date(Date.now() + 2000);
    expect(await history.inspect(owner, 'chat_expires')).toMatchObject({ classification: 'google', googleContext: { availability: 'expired' } });
    await expect(history.inherit(owner, 'chat_target', ['chat_expires'])).rejects.toThrow();
  });
  it('rechecks a Google target after the last awaited ordinary-source read', async () => {
    for (const name of ['google', 'ordinary']) await repository.create(owner, input(name));
    const target = await contexts.mark(mark('chat_google', { expiresAt: future(1000) }));
    let now = new Date();
    let reads = 0;
    const delayed = repository.kysely.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        if ((args.result.rows[0] as { born?: boolean } | undefined)?.born && ++reads === 2) now = new Date(Date.now() + 2000);
        return args.result;
      },
    });
    const guarded = createGoogleModelHistoryStore(delayed, { now: () => now });
    await expect(guarded.inherit(owner, 'chat_google', ['chat_ordinary'], target.revision)).rejects.toThrow();
  });
  it('sets production SQL limits when joining a caller transaction and leaves that pool usable', async () => {
    await repository.kysely.transaction().execute(async tx => {
      await boundedProvenanceTransaction(tx, async joined => {
        expect(joined).toBe(tx);
        const settings = (await sql<{ statement: string; lock: string }>`SELECT current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock`.execute(joined)).rows[0];
        expect(settings).toEqual({ statement: '5s', lock: '2s' });
      });
      await createGoogleModelHistoryStore(tx).migrate();
      await sql`SELECT 1`.execute(tx);
    });
    expect((await sql`SELECT 1`.execute(repository.kysely)).rows).toHaveLength(1);
  });
  it('rechecks expiry after an actual classification lock wait', async () => {
    for (const name of ['expiring', 'target']) await repository.create(owner, input(name));
    await contexts.mark(mark('chat_expiring', { expiresAt: future(300) }));
    await repository.kysely.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      const result = history.inherit(owner, 'chat_target', ['chat_expiring']).then(() => 'allowed', () => 'denied');
      try {
        await new Promise(resolve => setTimeout(resolve, 350));
        await sql`SELECT pg_advisory_unlock(551035504)`.execute(held);
        expect(await result).toBe('denied');
      } finally { await sql`SELECT pg_advisory_unlock_all()`.execute(held); }
    });
    expect(await contexts.inspect(owner.ownerId, 'chat_target')).toBeNull();
  });
  it('serializes concurrent inheritance and purge without reviving a closed generation', async () => {
    for (const name of ['source', 'target']) await repository.create(owner, input(name));
    await contexts.mark(mark('chat_source'));
    await Promise.allSettled([history.inherit(owner, 'chat_target', ['chat_source']), contexts.beginPurge(owner.ownerId, account)]);
    const target = await history.inspect(owner, 'chat_target');
    expect(target.classification === 'ordinary' || (target.classification === 'google' && target.googleContext.availability === 'purging')).toBe(true);
    await expect(history.inherit(owner, 'chat_target', ['chat_source'], target.classification === 'google' ? target.googleContext.revision : undefined)).rejects.toThrow();
  });
  it('bounds ids, source arrays and configuration, and does not own the caller pool', async () => {
    const destroy = vi.spyOn(repository.kysely, 'destroy');
    for (const ids of [[], Array(33).fill('chat_missing'), ['chat_../bad']]) {
      await expect(history.inherit(owner, 'chat_target', ids)).rejects.toThrow();
    }
    await expect(history.inspect({ type: 'personal', ownerId: 'x'.repeat(1000) }, 'chat_target')).rejects.toThrow();
    expect(() => createGoogleModelHistoryStore(repository.kysely, { maxBirthsPerOwner: 0 })).toThrow();
    expect(destroy).not.toHaveBeenCalled();
  });
});
