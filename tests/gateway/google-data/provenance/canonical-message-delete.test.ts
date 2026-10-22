import { createGoogleCanonicalMessageDeletionHandler } from '../../../../packages/gateway/src/google-data/provenance/canonical-message-delete.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { ChatRepository, type ChatRepositoryOptions } from '../../../../packages/gateway/src/chat/repository.js';
import { createGoogleModelHistoryStore } from '../../../../packages/gateway/src/google-data/runtime/model-history.js';
import { createGoogleContextStore } from '../../../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleProvenanceStore } from '../../../../packages/gateway/src/google-data/provenance/store.js';
import { createGoogleCanonicalMessageWriteHook, canonicalMessageEntityRef } from '../../../../packages/gateway/src/google-data/provenance/canonical-message-writes.js';
import { assistantCredentialOccurrenceId, sealAssistantCredential } from '../../../../packages/gateway/src/chat/assistant-credential-crypto.js';
import { bootstrapCollaborationDatabase } from '../../../../packages/gateway/src/collaboration/database.js';
import { createAuthorityFixture } from '../fixture-db.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const key = { chatId: 'chat_one', runId: 'run_one', messageId: 'msg_assistant' };
const account = '10000000-0000-4000-8000-000000000001';
const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
const delta = (text = 'synthetic mail summary') => ({ ...key, delta: text, createdAt: new Date().toISOString() });
let repository: ChatRepository;
let options: ChatRepositoryOptions;
let contexts: ReturnType<typeof createGoogleContextStore>;
let provenance: ReturnType<typeof createGoogleProvenanceStore>;
const copy = () => provenance.inspect(owner.ownerId, 'derived', canonicalMessageEntityRef(key.messageId));
async function mark(extra: Record<string, unknown> = {}) {
  return contexts.mark({ ownerId: owner.ownerId, chatId: key.chatId, googleAccountId: account,
    consentId: 'consent_one', profileId: 'managed', profileRevision: 1, purposeId: 'assistant',
    expiresAt: future(), retentionDeadline: future(), ...extra });
}
async function admit(repo: ChatRepository, suffix = 'one', subject = owner) {
  const chatId = `chat_${suffix}`;
  const created = await repo.create(subject, { id: chatId, clientRequestId: `req_create_${suffix}`, title: 'Synthetic' });
  const at = new Date().toISOString();
  const message = { id: `msg_user_${suffix}`, chatId, seq: 1, role: 'user' as const, state: 'committed' as const,
    purpose: 'ai_request' as const, turnId: `cturn_${suffix}`, parts: [{ type: 'text' as const, text: 'preserve owner words' }], createdAt: at };
  const turn = { id: `cturn_${suffix}`, chatId, clientRequestId: `req_turn_${suffix}`, baseMessageSeq: 0,
    inputMessageId: message.id, status: 'accepted' as const, createdAt: at, updatedAt: at };
  const run = { id: `run_${suffix}`, chatId, turnId: turn.id, attempt: 1, driverKind: 'codex' as const,
    instanceId: 'codex_default', selection: { instanceId: 'codex_default', model: 'synthetic' },
    interactionMode: 'default' as const, permissionMode: 'supervised' as const, status: 'accepted' as const, historyBoundarySeq: 0,
    capabilitySnapshot: { revision: 'catalog_1', rootChat: true, attachments: ['file' as const], resources: ['file' as const],
      tools: ['read'], approvals: true, userInput: true, resume: true, cancellation: true, steering: 'same_run' as const,
      worktrees: 'optional' as const, interactionModes: ['default' as const], permissionModes: ['supervised' as const] }, createdAt: at, updatedAt: at };
  await repo.admitTurn(subject, { chatId, baseRevision: created.chat.revision, message, turn, run });
}
beforeEach(async () => {
  const { db } = await createAuthorityFixture();
  repository = new ChatRepository(db.sql);
  await repository.bootstrap();
  await bootstrapCollaborationDatabase(repository.kysely as never);
  const history = createGoogleModelHistoryStore(repository.kysely);
  await history.migrate();
  options = { onServerCreatedEmptyChat: (tx, subject, chatId, receipt) => history.recordServerCreatedEmptyChat(tx, subject, chatId, receipt),
    assistantDeltaWrites: createGoogleCanonicalMessageWriteHook() };
  repository = new ChatRepository(repository.kysely, false, undefined, options);
  await admit(repository);
  contexts = createGoogleContextStore(repository.kysely);
  provenance = createGoogleProvenanceStore(repository.kysely);
  await provenance.migrate();
});


describe('canonical assistant copy redaction', () => {
  async function prepared() {
    await mark(); await repository.appendAssistantDelta(owner, delta());
    const registered = (await copy())!;
    return { ownerId: owner.ownerId, entityRef: registered.entityRef, expectedHash: registered.contentHash,
      signal: new AbortController().signal };
  }
  it('redacts only the exact owned assistant payload and preserves owner rows, ids and sequence', async () => {
    const input = await prepared();
    const before = await repository.kysely.selectFrom('chat_messages').selectAll().where('id','=',key.messageId).executeTakeFirstOrThrow();
    const result = await createGoogleCanonicalMessageDeletionHandler(repository.kysely)(input);
    expect(result.status).toBe('deleted');
    const messages = await repository.kysely.selectFrom('chat_messages').selectAll().where('chat_id','=',key.chatId).orderBy('seq').execute();
    expect(messages[0]!.parts).toEqual([{type:'text',text:'preserve owner words'}]);
    expect(messages[1]).toMatchObject({id:before.id,seq:before.seq,run_id:before.run_id,turn_id:before.turn_id,search_text:''});
    expect(JSON.stringify(messages[1]!.parts)).not.toContain('synthetic mail');
    expect(messages[1]!.byte_count).toBeGreaterThan(0);
    expect((await repository.get(owner,key.chatId))?.chat.lastMessagePreview).not.toContain('synthetic mail');
    const invalidation = await repository.kysely.selectFrom('chat_outbox').selectAll().orderBy('cursor','desc').executeTakeFirstOrThrow();
    expect(invalidation.event_type).toBe('chat.updated');
    expect(invalidation.payload).toEqual({});
  });
  it('is idempotent after redaction and reports genuinely absent content as missing', async () => {
    const input = await prepared(); const remove = createGoogleCanonicalMessageDeletionHandler(repository.kysely);
    expect((await remove(input)).status).toBe('deleted');
    expect((await remove(input)).status).toBe('missing');
    expect((await remove({...input,entityRef:'cm_msg_absent'})).status).toBe('missing');
  });
  it.each(['parts','search_text','byte_count'])('preserves a copy modified in %s', async field => {
    const input = await prepared();
    if(field==='parts') await sql`UPDATE chat_messages SET parts='[{"type":"text","text":"owner edited"}]'::jsonb WHERE id=${key.messageId}`.execute(repository.kysely);
    if(field==='search_text') await sql`UPDATE chat_messages SET search_text='owner edited' WHERE id=${key.messageId}`.execute(repository.kysely);
    if(field==='byte_count') await sql`UPDATE chat_messages SET byte_count=1 WHERE id=${key.messageId}`.execute(repository.kysely);
    const before = await repository.kysely.selectFrom('chat_messages').selectAll().where('id','=',key.messageId).executeTakeFirstOrThrow();
    expect((await createGoogleCanonicalMessageDeletionHandler(repository.kysely)(input)).status).toBe('modified');
    expect(await repository.kysely.selectFrom('chat_messages').selectAll().where('id','=',key.messageId).executeTakeFirstOrThrow()).toEqual(before);
  });
  it('never deletes a foreign owner or user message and refuses other entity kinds', async () => {
    const input = await prepared(); const remove=createGoogleCanonicalMessageDeletionHandler(repository.kysely);
    expect((await remove({...input,ownerId:'outsider'})).status).toBe('missing');
    expect((await remove({...input,entityRef:'cm_msg_user_one'})).status).toBe('modified');
    expect((await remove({...input,entityRef:'mpi_chat_one'})).status).toBe('unavailable');
    expect((await repository.kysely.selectFrom('chat_messages').selectAll().where('id','=',key.messageId).executeTakeFirstOrThrow()).search_text).toContain('synthetic mail');
  });
  it('removes exact owned encrypted sidecars in the same transaction', async () => {
    await mark(); const occurrenceId=assistantCredentialOccurrenceId(key.messageId,0);
    const envelope=sealAssistantCredential(Buffer.alloc(32,7),{ownerId:owner.ownerId,...key,occurrenceId},'SYNTHETIC_SECRET');
    await repository.appendAssistantDelta(owner,{...delta('[redacted]'),credentials:[{occurrenceId,offset:0,length:10,envelope}]});
    const registered=(await copy())!;
    expect((await createGoogleCanonicalMessageDeletionHandler(repository.kysely)({ownerId:owner.ownerId,entityRef:registered.entityRef,expectedHash:registered.contentHash,signal:new AbortController().signal})).status).toBe('deleted');
    expect(await repository.kysely.selectFrom('chat_credentials').select('id').where('message_id','=',key.messageId).execute()).toEqual([]);
  });
  it('leaves payload and side effects unchanged when cancellation occurs before or during the write', async () => {
    const input=await prepared(); const stopped=new AbortController(); stopped.abort();
    expect((await createGoogleCanonicalMessageDeletionHandler(repository.kysely)({...input,signal:stopped.signal})).status).toBe('unavailable');
    const during=new AbortController();
    const cancelling=repository.kysely.withPlugin({transformQuery:args=>args.node,async transformResult(args){
      if(args.result.rows.some(row=>row && typeof row==='object' && 'redacted_message_id' in row)) during.abort(); return args.result;
    }});
    expect((await createGoogleCanonicalMessageDeletionHandler(cancelling)({...input,signal:during.signal})).status).toBe('unavailable');
    expect((await repository.kysely.selectFrom('chat_messages').selectAll().where('id','=',key.messageId).executeTakeFirstOrThrow()).search_text).toContain('synthetic mail');
  });
  it('works through the actual copy-locked purge worker without taking the context lock', async () => {
    await prepared(); const context=await contexts.inspect(owner.ownerId,key.chatId);
    await provenance.requestPurge(owner.ownerId,context!.sources[0]!.originId,'request_one');
    const claim=(await provenance.claimPurge('worker'))!;
    expect(await provenance.executeClaim(claim,{derived:createGoogleCanonicalMessageDeletionHandler(repository.kysely)})).toBe('deleted');
    expect((await copy())?.state).toBe('deleted');
  });
  it('publishes only the content-free invalidation after a successful transaction', async () => {
    const input=await prepared();
    const notify=vi.fn();
    expect((await createGoogleCanonicalMessageDeletionHandler(repository.kysely,{onInvalidation:notify})(input)).status).toBe('deleted');
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({owner,event:{chatId:key.chatId,eventType:'chat.updated',payload:{}}});
    expect(JSON.stringify(notify.mock.calls)).not.toContain('synthetic mail');
  });
  it('requires the host database so a joined transaction cannot publish before its real COMMIT', async () => {
    await repository.withTransaction(async tx => {
      expect(()=>createGoogleCanonicalMessageDeletionHandler(tx.kysely)).toThrow();
    });
  });
});
