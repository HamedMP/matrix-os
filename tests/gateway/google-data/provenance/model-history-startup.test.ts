import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ChatRepository } from '../../../../packages/gateway/src/chat/repository.js';
import { createOwnerChatHistoryRepository } from '../../../../packages/gateway/src/startup/chat-history.js';
import { createGoogleModelHistoryStore } from '../../../../packages/gateway/src/google-data/runtime/model-history.js';
import { createAuthorityFixture } from '../fixture-db.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const create = (id: string) => ({ id: `chat_${id}`, clientRequestId: `req_${id}`, title: id });
let repository: ChatRepository;
beforeEach(async () => {
  const { db } = await createAuthorityFixture(); repository = new ChatRepository(db.sql); await repository.bootstrap();
});
describe('owner database history creation composition', () => {
  it('installs birth recording only after the history schema is ready', async () => {
    const startup = createOwnerChatHistoryRepository(repository.kysely); await startup.bootstrap();
    await startup.repository.create(owner, create('new'));
    expect(await createGoogleModelHistoryStore(repository.kysely).inspect(owner, 'chat_new')).toEqual({ classification: 'ordinary' });
  });
  it('never backfills existing chats or a replayed create request on restart', async () => {
    await repository.create(owner, create('old'));
    const startup = createOwnerChatHistoryRepository(repository.kysely); await startup.bootstrap();
    await startup.repository.create(owner, { ...create('replayed'), clientRequestId: 'req_old' });
    expect(await createGoogleModelHistoryStore(repository.kysely).inspect(owner, 'chat_old')).toEqual({ classification: 'unknown' });
    const restarted = createOwnerChatHistoryRepository(repository.kysely); await restarted.bootstrap();
    await restarted.repository.create(owner, create('new'));
    expect(await createGoogleModelHistoryStore(repository.kysely).inspect(owner, 'chat_new')).toEqual({ classification: 'ordinary' });
  });
  it('keeps birth and the actual successful chat insert in one caller transaction', async () => {
    const startup = createOwnerChatHistoryRepository(repository.kysely); await startup.bootstrap();
    await expect(startup.repository.withTransaction(async tx => {
      await tx.create(owner, create('rollback'));
      throw new Error('cancel');
    })).rejects.toThrow('cancel');
    expect(await startup.repository.get(owner, 'chat_rollback')).toBeNull();
    expect(await createGoogleModelHistoryStore(repository.kysely).inspect(owner, 'chat_rollback')).toEqual({ classification: 'unknown' });
  });
  it('does not own or destroy the injected pool on release', async () => {
    const startup = createOwnerChatHistoryRepository(repository.kysely); await startup.bootstrap(); await startup.repository.release();
    expect((await sql<{ alive: number }>`SELECT 1 AS alive`.execute(repository.kysely)).rows[0]!.alive).toBe(1);
  });
});
