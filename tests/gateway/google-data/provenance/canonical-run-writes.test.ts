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
const finish = (extra = {}) => repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString(), ...extra });
const attachment = () => ({ ...key, attachment: { id: 'attachment_one', kind: 'file' as const, label: 'summary.txt', path: 'files/summary.txt' }, createdAt: new Date().toISOString() });
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

describe('canonical completion and attachment copy writes', () => {
  it('re-registers every assistant payload in a finalized run, including replacement output', async () => {
    const context = await mark(); const expiry = future(60_000);
    await mark({ googleAccountId: '10000000-0000-4000-8000-000000000002', consentId: 'second', expiresAt: expiry, expectedRevision: context.revision });
    const first = await repository.appendAssistantDelta(owner, delta('first'));
    const second = await repository.appendAssistantDelta(owner, { ...delta('second'), messageId: 'msg_second' });
    const before = await repository.kysely.selectFrom('google_copy_registry').select(['entity_ref', 'content_hash']).orderBy('entity_ref').execute();
    const result = await finish({ output: { ...second, state: 'committed', parts: [{ type: 'text', text: 'replacement output' }] } });
    expect(result.transitioned).toBe(true);
    const after = await repository.kysely.selectFrom('google_copy_registry').select(['entity_ref', 'content_hash', 'revision']).orderBy('entity_ref').execute();
    expect(after).toHaveLength(2); expect(after.map(row => row.revision)).toEqual([2, 2]);
    expect(after.map(row => row.content_hash)).not.toEqual(before.map(row => row.content_hash));
    expect((await repository.kysely.selectFrom('chat_messages').select(['id', 'state']).where('role', '=', 'assistant').execute()).map(row => row.state)).toEqual(['committed', 'committed']);
    expect((await repository.kysely.selectFrom('chat_messages').select('parts').where('id', '=', 'msg_user_one').executeTakeFirst())?.parts).toEqual([{ type: 'text', text: 'preserve owner words' }]);
    expect(first.id).not.toBe(second.id); expect((await copy())?.origins).toHaveLength(2);
    expect((await copy())?.retentionDeadline).toBe(expiry);
  });
  it('registers supplied completion output when the run has no streamed assistant message', async () => {
    await mark();
    await finish({ output: { id: key.messageId, chatId: key.chatId, runId: key.runId, turnId: 'cturn_one', seq: 2,
      role: 'assistant', purpose: 'assistant', state: 'committed', parts: [{ type: 'text', text: 'final output' }], createdAt: new Date().toISOString() } });
    expect(await copy()).toMatchObject({ revision: 1, state: 'active' });
  });
  it('updates canonical hash for attachment references and preserves idempotent duplicate replay', async () => {
    await mark(); await repository.appendAssistantDelta(owner, delta()); const initial = await copy();
    await repository.appendAssistantAttachment(owner, attachment()); const changed = await copy();
    expect(changed?.contentHash).not.toBe(initial?.contentHash); expect(changed?.revision).toBe(2);
    await repository.appendAssistantAttachment(owner, attachment()); expect(await copy()).toEqual(changed);
    expect((await repository.kysely.selectFrom('chat_attachments').select('id').execute()).map(row => row.id)).toEqual(['attachment_one']);
  });
  it('registers a fresh attachment-only assistant message', async () => {
    await mark(); await repository.appendAssistantAttachment(owner, attachment()); expect(await copy()).toMatchObject({ revision: 1 });
  });
  it('fails closed for one missing or modified lineage without partially finishing any message', async () => {
    await mark(); await repository.appendAssistantDelta(owner, delta());
    await repository.appendAssistantDelta(owner, { ...delta('second'), messageId: 'msg_second' });
    await repository.kysely.deleteFrom('google_copy_registry').where('entity_ref', '=', canonicalMessageEntityRef('msg_second')).execute();
    await expect(finish()).rejects.toThrow(); expect((await copy())?.revision).toBe(1);
    expect((await repository.kysely.selectFrom('chat_runs').select('status').where('id', '=', key.runId).executeTakeFirst())?.status).toBe('accepted');
    await repository.kysely.updateTable('chat_messages').set({ search_text: 'modified' }).where('id', '=', key.messageId).execute();
    await expect(repository.appendAssistantAttachment(owner, attachment())).rejects.toThrow();
    expect(await repository.kysely.selectFrom('chat_attachments').select('id').execute()).toEqual([]);
  });
  it('rolls run/turn/messages and copy revisions back together on caller rollback', async () => {
    await mark(); await repository.appendAssistantDelta(owner, delta()); const before = await copy();
    await expect(repository.withTransaction(async tx => { await tx.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() }); throw new Error('rollback'); })).rejects.toThrow();
    expect(await copy()).toEqual(before);
    expect((await repository.kysely.selectFrom('chat_messages').select('state').where('id', '=', key.messageId).executeTakeFirst())?.state).toBe('pending');
  });
  it.each(['finish', 'attachment'] as const)('rejects pre-cancelled %s and cross-owner writes', async operation => {
    await mark(); await repository.appendAssistantDelta(owner, delta());
    const controller = new AbortController(); controller.abort();
    await expect(operation === 'finish' ? repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() }, controller.signal)
      : repository.appendAssistantAttachment(owner, attachment(), controller.signal)).rejects.toThrow();
    await expect(repository.finishRun({ type: 'personal', ownerId: 'other' }, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() })).rejects.toThrow();
    expect((await copy())?.revision).toBe(1);
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('completion/attachment live deadlines and locks', () => {
  it.each(['finish', 'attachment'] as const)('withholds all %s delivery after actual COMMIT cancellation or expiry', async operation => {
    await mark({ expiresAt: future(60_000) }); await repository.appendAssistantDelta(owner, delta());
    let clock = new Date(); const controller = new AbortController();
    const repo = new ChatRepository(repository.kysely, false, undefined, { ...options, assistantDeltaWrites: createGoogleCanonicalMessageWriteHook({ now: () => clock }) });
    const sink = vi.fn(); repo.registerOutboxSink(sink); const committed = deferred(); const release = deferred();
    const transaction = repo.kysely.transaction.bind(repo.kysely);
    const spy = vi.spyOn(repo.kysely, 'transaction').mockImplementation(() => {
      const builder = transaction(); const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(async work => { const result = await execute(work); committed.resolve(); await release.promise; return result; });
      return builder;
    });
    const outcome = (operation === 'finish'
      ? repo.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() }, controller.signal)
      : repo.appendAssistantAttachment(owner, attachment(), controller.signal)).then(() => 'released', () => 'withheld');
    try { await committed.promise; if (operation === 'finish') controller.abort(); else clock = new Date(clock.getTime() + 120_000); }
    finally { release.resolve(); spy.mockRestore(); }
    expect(await outcome).toBe('withheld'); expect(sink).not.toHaveBeenCalled(); expect((await copy())?.revision).toBe(2);
  });
  it('takes every sorted registry lock before chat/content while a real purge worker holds a later copy', async () => {
    const context = await mark(); await repository.appendAssistantDelta(owner, delta());
    await repository.appendAssistantDelta(owner, { ...delta('second'), messageId: 'msg_second' });
    await provenance.requestPurge(owner.ownerId, context.sources[0]!.originId, 'request');
    const claims = [(await provenance.claimPurge('worker'))!, (await provenance.claimPurge('worker'))!];
    const later = (await sql<{ id: string }>`SELECT j.id FROM google_copy_purge_jobs j JOIN google_copy_registry c ON c.id=j.copy_id WHERE c.entity_ref=${canonicalMessageEntityRef('msg_second')}`.execute(repository.kysely)).rows[0]!.id;
    const claim = claims.find(item => item.jobId === later)!;
    const entered = deferred(); const proceed = deferred(); const attempted = deferred();
    const observed = repository.kysely.withPlugin({ transformQuery(args) {
      if (JSON.stringify(args.node).includes('ORDER BY entity_ref FOR UPDATE')) attempted.resolve(); return args.node;
    }, async transformResult(args) { return args.result; } });
    const repo = new ChatRepository(observed, false, undefined, options);
    const deletion = provenance.executeClaim(claim, { derived: async () => {
      entered.resolve(); await proceed.promise;
      await repository.kysely.transaction().execute(async tx => {
        await sql`SET LOCAL lock_timeout = '500ms'`.execute(tx);
        await tx.selectFrom('chats').select('id').where('id', '=', key.chatId).forUpdate().execute();
      }); return { status: 'unavailable' };
    } });
    await entered.promise;
    const writing = repo.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() }).then(() => 'written', () => 'denied');
    try { await attempted.promise; } finally { proceed.resolve(); }
    expect(await deletion).toBe('unresolved'); expect(await writing).toBe('denied');
  });
  it('pins completion and attachment inputs before awaiting the source fence', async () => {
    await mark(); await repository.appendAssistantDelta(owner, delta());
    const input = attachment(); let pending!: Promise<unknown>;
    await repository.kysely.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      try { pending = repository.appendAssistantAttachment(owner, input); input.messageId = 'msg_changed'; input.attachment.path = 'files/changed'; }
      finally { await sql`SELECT pg_advisory_unlock(551035504)`.execute(held); }
    });
    await pending;
    expect((await repository.kysely.selectFrom('chat_attachments').select('owner_reference').executeTakeFirst())?.owner_reference).toBe('files/summary.txt');
    const completion = { chatId: key.chatId, runId: key.runId, outcome: 'completed' as const, completedAt: new Date().toISOString() };
    await repository.kysely.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      try { pending = repository.finishRun(owner, completion); completion.chatId = 'chat_changed'; completion.runId = 'run_changed'; }
      finally { await sql`SELECT pg_advisory_unlock(551035504)`.execute(held); }
    });
    await pending; expect((await repository.kysely.selectFrom('chat_runs').select('status').where('id', '=', key.runId).executeTakeFirst())?.status).toBe('completed');
  });
});

describe('bounded completion discovery', () => {
  it('rejects a changed candidate set after waiting for copy locks without blessing the new opaque row', async () => {
    await mark(); await repository.appendAssistantDelta(owner, delta());
    const attempted = deferred();
    const observed = repository.kysely.withPlugin({ transformQuery(args) {
      if (JSON.stringify(args.node).includes('ORDER BY entity_ref FOR UPDATE')) attempted.resolve(); return args.node;
    }, async transformResult(args) { return args.result; } });
    const repo = new ChatRepository(observed, false, undefined, options); let writing!: Promise<string>;
    await repository.kysely.transaction().execute(async held => {
      await sql`SELECT id FROM google_copy_registry FOR UPDATE`.execute(held);
      writing = repo.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() }).then(() => 'written', () => 'denied');
      await attempted.promise;
      await sql`INSERT INTO chat_messages (id,chat_id,seq,role,state,purpose,turn_id,run_id,parts,byte_count,search_text,created_at)
        SELECT 'msg_unqualified',chat_id,3,role,state,purpose,turn_id,run_id,parts,byte_count,search_text,created_at FROM chat_messages WHERE id=${key.messageId}`.execute(repository.kysely);
    });
    expect(await writing).toBe('denied'); expect((await copy())?.revision).toBe(1);
    expect(await provenance.inspect(owner.ownerId, 'derived', canonicalMessageEntityRef('msg_unqualified'))).toBeNull();
  });
  it('refuses more than 64 assistant candidates before taking content locks or changing state', async () => {
    await mark(); await repository.appendAssistantDelta(owner, delta());
    await sql`INSERT INTO chat_messages (id,chat_id,seq,role,state,purpose,turn_id,run_id,parts,byte_count,search_text,created_at)
      SELECT 'msg_extra_' || n::text,chat_id,n+2,role,state,purpose,turn_id,run_id,parts,byte_count,search_text,created_at
      FROM chat_messages CROSS JOIN generate_series(1,64) n WHERE id=${key.messageId}`.execute(repository.kysely);
    await expect(finish()).rejects.toThrow(); expect((await copy())?.revision).toBe(1);
    expect((await repository.kysely.selectFrom('chat_runs').select('status').where('id', '=', key.runId).executeTakeFirst())?.status).toBe('accepted');
  });
});
