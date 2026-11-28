import { describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import { createCanonicalChatEventStream } from '../../packages/gateway/src/chat/event-stream.js';
import type { ChatOutboxEvent } from '../../packages/gateway/src/chat/records.js';
import type { ChatOutboxSink } from '../../packages/gateway/src/chat/outbox-delivery.js';
import type { CanonicalChatTransportFrame } from '@matrix-os/contracts';
const owner = { type: 'personal' as const, ownerId: 'owner_one' };

describe('metadata-only delayed canonical events', () => {
  it('projects bounded replay-window metadata in SQL without changing owner raw replay or inspection', async () => {
    const { db } = await createAuthorityFixture(); const repo = new ChatRepository(db.sql); await repo.bootstrap();
    await repo.create(owner, { id: 'chat_one', clientRequestId: 'req_one', title: 'synthetic private title' });
    const raw = await repo.replayOutbox(owner, { afterCursor: 0, limit: 10 });
    expect(JSON.stringify(raw)).toContain('synthetic private title');
    const rawRead = vi.spyOn(repo, 'replayOutbox');
    const window = await repo.replayOutboxWindow(owner, { limit: 10 });
    expect(rawRead).not.toHaveBeenCalled();
    expect(window).toMatchObject({ events: [{ cursor: raw[0]!.cursor, chatId: 'chat_one', payload: {} }], gap: false });
    expect(JSON.stringify(window)).not.toContain('synthetic private title');
    expect((await repo.get(owner, 'chat_one'))?.chat.title).toBe('synthetic private title');
    expect((await sql<{ payload: unknown }>`SELECT payload FROM chat_outbox`.execute(repo.kysely)).rows[0]!.payload).toEqual(raw[0]!.payload);
    expect(await repo.replayOutboxWindow({ type: 'personal', ownerId: 'other' }, { limit: 10 })).toMatchObject({ events: [] });
  });

  it('copies only bounded metadata into attach buffers and never emits replayed content', async () => {
    let publish!: ChatOutboxSink; let resolve!: (value: { events: ChatOutboxEvent[]; gap: boolean }) => void;
    const replay = new Promise<{ events: ChatOutboxEvent[]; gap: boolean }>(done => { resolve = done; });
    const stream = createCanonicalChatEventStream({ repository: {
      registerOutboxSink(sink) { publish = sink; return { dispose() {} }; },
      replayOutboxWindow() { return replay; },
    } });
    const sent: CanonicalChatTransportFrame[] = [];
    const opening = stream.open({ principal: { userId: owner.ownerId, source: 'jwt' }, content: true,
      sink: { send: frame => { sent.push(frame); return true; }, close() {} } });
    const payload = { transcript: 'synthetic private transcript' };
    const event: ChatOutboxEvent = { cursor: 2, chatId: 'chat_buffer', revision: 2,
      eventType: 'chat.updated', createdAt: new Date().toISOString(), payload };
    publish({ owner, event });
    event.chatId = 'chat_mutated'; payload.transcript = 'changed after enqueue';
    resolve({ events: [{ ...event, cursor: 1, chatId: 'chat_replay' }], gap: false });
    await opening;
    expect(sent.filter(frame => frame.type === 'chat.event').map(frame => frame.event.chatId)).toEqual(['chat_replay', 'chat_buffer']);
    expect(sent.some(frame => frame.type === 'chat.content')).toBe(false);
    expect(JSON.stringify(sent)).not.toMatch(/transcript|changed after enqueue|chat_mutated/);
    stream.shutdown();
  });
});
