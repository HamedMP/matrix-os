import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { bootstrapCollaborationDatabase } from '../../packages/gateway/src/collaboration/database.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import * as projection from '../../packages/gateway/src/chat/content-projection.js';
import type { ChatOutboxEventType, ChatOutboxEvent } from '../../packages/gateway/src/chat/records.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { createCanonicalChatFixture } from '../contracts/fixtures/canonical-chat.js';
import { createCanonicalChatEventStream } from '../../packages/gateway/src/chat/event-stream.js';
import { registerCanonicalChatEventHttpRoute } from '../../packages/gateway/src/chat/event-http-route.js';
import { createCanonicalChatEventSource, type CanonicalChatInvalidation } from '../../packages/ui/src/canonical-chat-event-source.js';
const owner = { type: 'personal' as const, ownerId: 'owner_metadata' };
const types: Record<ChatOutboxEventType, true> = {
  'chat.created': true, 'chat.updated': true, 'chat.user_state_updated': true, 'turn.accepted': true,
  'queue.enqueued': true, 'queue.updated': true, 'queue.cancelled': true, 'queue.reordered': true, 'queue.claimed': true,
  'run.steer_requested': true, 'run.steered': true, 'run.steer_failed': true, 'run.activity': true, 'run.message': true,
  'chat.terminal_bound': true, 'run.completed': true, 'run.failed': true, 'run.aborted': true, 'chat.deleted': true,
  'migration.completed': true, 'bot.created': true, 'interaction.requested': true, 'interaction.resolved': true,
  'bot.task.updated': true, 'bot.authority.changed': true, 'bot.memory.remembered': true,
};
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const { db } = await createAuthorityFixture(); const options = { contentProjectionMode: 'metadata-only' as const };
  const repo = new ChatRepository(db.sql, false, undefined, options); await repo.bootstrap(); return { repo, options, db: db.sql };
}

describe('server-only metadata outbox mode', () => {
  it('persists empty payloads for every event type, never calls content capture, and propagates to nested transactions', async () => {
    const capture = vi.spyOn(projection, 'captureChatContent'); const { repo } = await setup();
    await repo.create(owner, { id: 'chat_metadata', clientRequestId: 'req_metadata', title: 'private title' });
    const sink = vi.fn(); repo.registerOutboxSink(sink);
    const payload = { transcript: 'private transcript', preview: 'private preview', error: 'private error',
      streamContent: { arbitrary: 'untrusted content' }, activityIds: ['activity_private'], failureDiagnostic: { error: 'private diagnostic' } };
    await repo.withTransaction(async outer => {
      for (const event of Object.keys(types) as ChatOutboxEventType[]) {
        await outer.withTransaction(inner => inner.appendOutboxEvent(owner, 'chat_metadata', 1, event, payload));
      }
      expect(sink).not.toHaveBeenCalled();
    });
    const rows = (await sql<{ payload: unknown }>`SELECT payload FROM chat_outbox`.execute(repo.kysely)).rows;
    expect(rows).toHaveLength(Object.keys(types).length + 1); expect(rows.every(row => JSON.stringify(row.payload) === '{}')).toBe(true);
    expect(sink.mock.calls).toHaveLength(Object.keys(types).length); expect(sink.mock.calls.every(([input]) => JSON.stringify(input.event.payload) === '{}')).toBe(true);
    expect(capture).not.toHaveBeenCalled(); expect((await repo.get(owner, 'chat_metadata'))?.chat.title).toBe('private title');
  });
  it('covers actual activity/message/preview/failure persistence while preserving canonical owner reads', async () => {
    const capture = vi.spyOn(projection, 'captureChatContent'); const { repo } = await setup();
    const { snapshot } = createCanonicalChatFixture('running'); const chatId = snapshot.chat.id;
    await repo.create(owner, { id: chatId, clientRequestId: 'req_run', title: 'private title' });
    const turn = { ...snapshot.turns[0]!, status: 'accepted' as const };
    const run = { ...snapshot.runs[0]!, status: 'accepted' as const };
    await repo.admitTurn(owner, { chatId, baseRevision: 0, message: snapshot.messages[0]!, turn, run });
    await repo.appendRunActivities(owner, chatId, run.id, [{ id: 'activity_private', chatId, runId: run.id,
      type: 'agent.activity', activityId: 'tool_private', kind: 'command', label: 'private activity', status: 'running', occurredAt: snapshot.chat.createdAt }]);
    await repo.appendAssistantDelta(owner, { chatId, runId: run.id, messageId: 'msg_private', delta: 'private assistant body', createdAt: snapshot.chat.createdAt });
    await repo.finishRun(owner, { chatId, runId: run.id, outcome: 'failed', completedAt: snapshot.chat.createdAt, diagnostic: { stage: 'execution', category: 'unknown' } });
    const events = await repo.replayOutbox(owner, { afterCursor: 0, limit: 100 });
    expect(events.every(event => JSON.stringify(event.payload) === '{}')).toBe(true); expect(capture).not.toHaveBeenCalled();
    expect(events.map(event => event.eventType)).toEqual(expect.arrayContaining(['turn.accepted', 'run.activity', 'run.message', 'run.failed']));
    const detail = await repo.getDetailPage(owner, chatId, { limit: 100 });
    expect(JSON.stringify(detail)).toContain('private assistant body'); expect(JSON.stringify(detail)).toContain('private activity');
  });
  it('keeps shared queued-run scope routing while discarding arbitrary collaboration payload content', async () => {
    const capture = vi.spyOn(projection, 'captureChatContent'); const { repo, db } = await setup();
    await bootstrapCollaborationDatabase(db);
    const { snapshot } = createCanonicalChatFixture('running'); const chatId = snapshot.chat.id;
    await repo.create(owner, { id: chatId, clientRequestId: 'req_shared', title: 'private shared' });
    const turn = { ...snapshot.turns[0]!, status: 'accepted' as const }; const run = { ...snapshot.runs[0]!, status: 'accepted' as const };
    await repo.admitTurn(owner, { chatId, baseRevision: 0, message: snapshot.messages[0]!, turn, run });
    const scope = '10000000-0000-4000-8000-000000000001';
    await sql`INSERT INTO collaboration_scopes (id,owner_type,owner_id,kind,resource_id,membership_mode,lifecycle,
      authority_runtime_id,organization_id,revision,auth_epoch,authority_generation,created_at,updated_at)
      VALUES (${scope},'personal',${owner.ownerId},'chat',${chatId},'direct','shared',
      '10000000-0000-4000-8000-000000000002','org_synthetic',1,1,1,now(),now())`.execute(repo.kysely);
    await sql`INSERT INTO chat_queued_turns (id,chat_id,client_request_id,position,status,parts,driver_kind,instance_id,
      selection,interaction_mode,permission_mode,capability_snapshot,claimed_run_id,collaboration_scope_id,created_at,updated_at)
      VALUES ('qturn_shared',${chatId},'req_shared_queue',1,'claimed','[]','codex','codex_fixture','{}','default','supervised','{}',
      ${run.id},${scope},now(),now())`.execute(repo.kysely);
    await repo.appendOutboxEvent(owner, chatId, 2, 'run.activity', { runId: run.id, summary: 'private collaboration summary' });
    const events = (await sql<{ payload: unknown; resource_id: string; scope_seq: string }>`SELECT payload,resource_id,scope_seq FROM collaboration_events`.execute(repo.kysely)).rows;
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ payload: {}, resource_id: chatId });
    expect((await repo.replayOutbox(owner, { afterCursor: 0, limit: 100 })).map(event => event.eventType)).not.toContain('run.activity');
    expect(capture).not.toHaveBeenCalled();
  });
  it('snapshots the server setting so later caller option mutation cannot re-enable copied projections', async () => {
    const { repo, options } = await setup(); Reflect.deleteProperty(options, 'contentProjectionMode');
    await repo.withTransaction(tx => tx.create(owner, { id: 'chat_fixed_mode', clientRequestId: 'req_fixed', title: 'private fixed title' }));
    expect((await repo.replayOutbox(owner, { afterCursor: 0, limit: 10 }))[0]!.payload).toEqual({});
  });
  it('sanitizes external committed events without reading their payload or mutating the caller object', async () => {
    const { repo } = await setup(); const sink = vi.fn(); repo.registerOutboxSink(sink);
    const event: ChatOutboxEvent = { cursor: 123, chatId: 'chat_external', revision: 7, eventType: 'run.message',
      createdAt: new Date().toISOString(), get payload() { throw new Error('payload must not be read'); } };
    repo.publishCommittedExternalOutbox(owner, event);
    expect(sink).toHaveBeenCalledWith({ owner, event: { cursor: 123, chatId: 'chat_external', revision: 7,
      eventType: 'run.message', createdAt: event.createdAt, payload: {} } });
  });
  it('does not erase historical outbox copies or change uninstalled content projections', async () => {
    const { repo } = await setup(); const legacy = new ChatRepository(repo.kysely);
    await legacy.create(owner, { id: 'chat_old', clientRequestId: 'req_old', title: 'historical title' });
    const old = await legacy.replayOutbox(owner, { afterCursor: 0, limit: 100 });
    expect(JSON.stringify(old)).toContain('historical title');
    await repo.create(owner, { id: 'chat_new', clientRequestId: 'req_new', title: 'new private title' });
    const rows = await repo.replayOutbox(owner, { afterCursor: 0, limit: 100 });
    expect(rows[0]!.payload).toEqual(old[0]!.payload); expect(rows[1]!.payload).toEqual({});
  });
  it('delivers negotiated metadata to the existing client invalidation fallback', async () => {
    const { repo } = await setup(); await repo.create(owner, { id: 'chat_client', clientRequestId: 'req_client', title: 'private' });
    const stream = createCanonicalChatEventStream({ repository: repo }); const app = new Hono();
    registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => ({ userId: owner.ownerId, source: 'jwt' }) });
    const source = createCanonicalChatEventSource({ openStream: async () => app.request('/api/chats/events', { headers: { accept: 'text/event-stream', 'x-matrix-chat-protocol': '2' } }) });
    const changes: CanonicalChatInvalidation[] = []; source.subscribe(next => changes.push(next));
    try {
      await source.start(); await vi.waitFor(() => expect(source.connectionState()).toBe('open')); changes.length = 0;
      await repo.appendOutboxEvent(owner, 'chat_client', 2, 'run.message', { preview: 'never copied' });
      await vi.waitFor(() => expect(changes).toEqual([expect.objectContaining({ type: 'chat.changed', chatId: 'chat_client' })]));
      expect(JSON.stringify(changes)).not.toContain('never copied');
    } finally { source.dispose(); stream.shutdown(); }
  });
});
