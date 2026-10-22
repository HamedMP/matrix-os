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

import { createGoogleContextSnapshotAdapter, runContextEntityRef, queueContextEntityRef } from '../../../../packages/gateway/src/google-data/provenance/context-snapshot-copies.js';
const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const key = { chatId: 'chat_one', runId: 'run_one', messageId: 'msg_assistant' };
const account = '10000000-0000-4000-8000-000000000001';
const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
const delta = (text = 'synthetic mail summary') => ({ ...key, delta: text, createdAt: new Date().toISOString() });
let repository: ChatRepository;
let snapshotAdapter: ReturnType<typeof createGoogleContextSnapshotAdapter>;
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
  snapshotAdapter = createGoogleContextSnapshotAdapter(repository.kysely); await snapshotAdapter.migrate();
  repository = new ChatRepository(repository.kysely, false, undefined, { ...options, contextWrites: snapshotAdapter });
});

const context = { version: 1 as const, requestHash: 'a'.repeat(64), chats: [{ chatId: 'chat_one', title: 'Synthetic source', throughSeq: 1, text: 'synthetic mail-derived context', truncated: false }] };
async function enqueue(repo = repository, id = 'qturn_one') {
  const run = (await repo.getDetailPage(owner, key.chatId, { limit: 20 }))!.runs[0]!;
  return repo.enqueueQueuedTurn(owner, { chatId: key.chatId, baseRevision: (await repo.get(owner, key.chatId))!.chat.revision,
    queuedTurnId: id, clientRequestId: `req_${id}`, parts: [{ type: 'text', text: 'preserve owner queue intent' }], driverKind: run.driverKind,
    selection: run.selection, interactionMode: run.interactionMode, permissionMode: run.permissionMode,
    capabilitySnapshot: run.capabilitySnapshot, context, createdAt: new Date().toISOString() });
}
async function admitContext() {
  const chatId = 'chat_two'; const created = await repository.create(owner, { id: chatId, clientRequestId: 'req_two', title: 'Context' });
  await contexts.mark({ ownerId: owner.ownerId, chatId, googleAccountId: account, consentId: 'consent_two', profileId: 'managed', profileRevision: 1,
    purposeId: 'assistant', expiresAt: future(), retentionDeadline: future() });
  const original = (await repository.getDetailPage(owner, key.chatId, { limit: 20 }))!;
  const at = new Date().toISOString(); const message = { ...original.messages[0]!, id: 'msg_user_two', chatId, turnId: 'cturn_two', createdAt: at };
  const turn = { ...original.turns[0]!, id: 'cturn_two', chatId, inputMessageId: message.id, clientRequestId: 'req_turn_two' };
  const run = { ...original.runs[0]!, id: 'run_two', chatId, turnId: turn.id, context };
  return repository.admitTurn(owner, { chatId, baseRevision: created.chat.revision, message, turn, run });
}
const inspectRun = (id: string) => provenance.inspect(owner.ownerId, 'derived', runContextEntityRef(id));
const inspectQueue = (id = 'qturn_one') => provenance.inspect(owner.ownerId, 'derived', queueContextEntityRef(id));
describe('durable run and queue context snapshot copies', () => {
  it('registers fresh admission and retry contexts with original source retention', async () => {
    const admitted = await admitContext(); expect(await inspectRun('run_two')).toMatchObject({ revision: 1, state: 'active' });
    await repository.kysely.updateTable('chat_runs').set({ status: 'failed' }).where('id', '=', 'run_two').execute();
    const revision = (await repository.get(owner, 'chat_two'))!.chat.revision;
    await repository.admitRetry(owner, { chatId: 'chat_two', turnId: 'cturn_two', clientRequestId: 'req_retry_two', baseRevision: revision,
      run: { ...admitted.run, id: 'run_retry', attempt: 2, context: { ...context, requestHash: 'b'.repeat(64) } } });
    expect(await inspectRun('run_retry')).toMatchObject({ revision: 1 });
    expect(JSON.stringify(await inspectRun('run_retry'))).not.toContain('synthetic mail-derived');
  });
  it('registers enqueue and newly assembled claimed-run history without changing queue hash for status changes', async () => {
    await mark(); await enqueue(); const before = await inspectQueue(); expect(before).toMatchObject({ revision: 1 });
    await repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() });
    const claimed = await repository.claimNextQueuedTurn(owner, { chatId: key.chatId, turnId: 'cturn_claimed', runId: 'run_claimed', messageId: 'msg_claimed', claimedAt: new Date().toISOString() });
    expect(claimed).not.toBeNull(); expect(await inspectRun('run_claimed')).toMatchObject({ revision: 1 }); expect(await inspectQueue()).toEqual(before);
  });
  it('rolls snapshot registration back with content and rejects missing/modified existing lineage', async () => {
    await mark(); await expect(repository.withTransaction(async tx => { await enqueue(tx); throw new Error('rollback'); })).rejects.toThrow();
    expect(await inspectQueue()).toBeNull(); await enqueue(); const copy = (await inspectQueue())!;
    await sql`UPDATE chat_queued_turns SET context_snapshot=jsonb_set(context_snapshot,'{chats,0,text}','"modified"')`.execute(repository.kysely);
    await expect(enqueue()).rejects.toThrow(); expect((await inspectQueue())?.revision).toBe(copy.revision);
  });
  it('preserves owner queue intent on cancellation and exact context deletion with idempotent retry', async () => {
    await mark(); await enqueue(); const copy = (await inspectQueue())!;
    await repository.cancelQueuedTurn(owner, { chatId: key.chatId, queuedTurnId: 'qturn_one', clientRequestId: 'req_cancel', baseRevision: (await repository.get(owner, key.chatId))!.chat.revision, cancelledAt: new Date().toISOString() });
    expect(await inspectQueue()).toEqual(copy);
    const args = { ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: new AbortController().signal };
    expect(await snapshotAdapter.delete(args)).toEqual({ status: 'deleted' }); expect(await snapshotAdapter.delete(args)).toEqual({ status: 'deleted' });
    const row = await repository.kysely.selectFrom('chat_queued_turns').select(['parts', 'context_snapshot', 'status']).where('id', '=', 'qturn_one').executeTakeFirst();
    expect(row).toEqual({ parts: [{ type: 'text', text: 'preserve owner queue intent' }], context_snapshot: null, status: 'cancelled' });
  });
  it('requires inactive runs and exact owned hash before clearing a run context', async () => {
    await admitContext(); const copy = (await inspectRun('run_two'))!;
    const args = { ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: new AbortController().signal };
    expect(await snapshotAdapter.delete(args)).toEqual({ status: 'unavailable' });
    expect(await snapshotAdapter.delete({ ...args, ownerId: 'outsider' })).toEqual({ status: 'missing' });
    await repository.kysely.updateTable('chat_runs').set({ status: 'completed' }).where('id', '=', 'run_two').execute();
    expect(await snapshotAdapter.delete(args)).toEqual({ status: 'deleted' });
    expect((await repository.kysely.selectFrom('chat_messages').select('parts').where('id', '=', 'msg_user_two').executeTakeFirst())?.parts).toEqual([{ type: 'text', text: 'preserve owner words' }]);
  });
});

describe('trusted context pre-claim quiescence', () => {
  it('requires queue admission and cancels queued work before exact snapshot redaction while preserving intent', async () => {
    await mark(); await enqueue(); const copy = (await inspectQueue())!; const args = { ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: new AbortController().signal };
    expect(await snapshotAdapter.delete(args)).toEqual({ status: 'unavailable' });
    await expect(snapshotAdapter.quiesceCopy(owner.ownerId, copy.entityRef)).rejects.toThrow();
    await contexts.beginPurge(owner.ownerId, account);
    const admission = vi.fn(async (_target, work) => work());
    const adapter = createGoogleContextSnapshotAdapter(repository.kysely, { queueAdmission: { withStoppedQueue: admission } });
    expect(await adapter.quiesceCopy(owner.ownerId, copy.entityRef)).toMatchObject({ quiesced: true });
    expect(admission).toHaveBeenCalledWith(expect.objectContaining({ ownerId: owner.ownerId, chatId: key.chatId, queuedTurnId: 'qturn_one' }), expect.any(Function));
    expect(await adapter.delete(args)).toEqual({ status: 'deleted' });
    expect((await repository.kysely.selectFrom('chat_queued_turns').select(['parts', 'status']).executeTakeFirst())!).toMatchObject({ parts: [{ type: 'text', text: 'preserve owner queue intent' }], status: 'cancelled' });
  });
  it('requires actual stopped-run admission for claimed queue work before both worker copies can settle', async () => {
    const source = await mark(); await enqueue();
    await repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() });
    await repository.claimNextQueuedTurn(owner, { chatId: key.chatId, turnId: 'cturn_claimed', runId: 'run_claimed', messageId: 'msg_claimed', claimedAt: new Date().toISOString() });
    await contexts.beginPurge(owner.ownerId, account); let drained = false;
    const adapter = createGoogleContextSnapshotAdapter(repository.kysely, { queueAdmission: { async withStoppedQueue(_target, work) { return work(); } },
      quiescence: { async withStoppedRun(target, work) { expect(target.runId).toBe('run_claimed'); drained = true; return work(); } } });
    await adapter.quiesceCopy(owner.ownerId, queueContextEntityRef('qturn_one')); expect(drained).toBe(true);
    expect((await repository.kysely.selectFrom('chat_runs').select('status').where('id', '=', 'run_claimed').executeTakeFirst())?.status).toBe('aborted');
    const receipt = await provenance.requestPurge(owner.ownerId, source.sources[0]!.originId, 'request');
    for (let index = 0; index < 2; index++) { const claim = (await provenance.claimPurge('worker'))!; expect(await provenance.executeClaim(claim, { derived: adapter.delete })).toBe('deleted'); }
    expect(await provenance.status(owner.ownerId, receipt.id)).toMatchObject({ complete: true, deleted: 2 });
    expect((await repository.kysely.selectFrom('chat_messages').select('parts').where('id', '=', 'msg_claimed').executeTakeFirst())?.parts).toEqual([{ type: 'text', text: 'preserve owner queue intent' }]);
  });
  it('denies declined or cancelled queue admission without changing lifecycle/content', async () => {
    await mark(); await enqueue(); const controller = new AbortController();
    const denied = createGoogleContextSnapshotAdapter(repository.kysely, { queueAdmission: { async withStoppedQueue() { return null; } } });
    await expect(denied.quiesceCopy(owner.ownerId, queueContextEntityRef('qturn_one'))).rejects.toThrow();
    const aborted = createGoogleContextSnapshotAdapter(repository.kysely, { queueAdmission: { async withStoppedQueue(_target, work) { controller.abort(); return work(); } } });
    await expect(aborted.quiesceCopy(owner.ownerId, queueContextEntityRef('qturn_one'), controller.signal)).rejects.toThrow();
    expect((await repository.kysely.selectFrom('chat_queued_turns').select(['status', 'context_snapshot']).executeTakeFirst())!).toMatchObject({ status: 'queued', context_snapshot: context });
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('context snapshot release and bounds', () => {
  it.each(['abort', 'expiry'] as const)('withholds enqueue acknowledgement/live batch after %s during actual COMMIT-return', async change => {
    await mark({ expiresAt: future(60_000) }); let clock = new Date(); const controller = new AbortController();
    const repo = new ChatRepository(repository.kysely, false, undefined, { ...options,
      contextWrites: createGoogleContextSnapshotAdapter(repository.kysely, { now: () => clock }) });
    const sink = vi.fn(); repo.registerOutboxSink(sink); const committed = deferred(); const release = deferred();
    const transaction = repo.kysely.transaction.bind(repo.kysely);
    const spy = vi.spyOn(repo.kysely, 'transaction').mockImplementation(() => {
      const builder = transaction(); const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(async work => { const result = await execute(work); committed.resolve(); await release.promise; return result; }); return builder;
    });
    const run = (await repository.getDetailPage(owner, key.chatId, { limit: 20 }))!.runs[0]!;
    const pending = repo.enqueueQueuedTurn(owner, { chatId: key.chatId, baseRevision: 1, queuedTurnId: 'qturn_one', clientRequestId: 'req_qturn_one', parts: [{ type: 'text', text: 'preserve' }],
      driverKind: run.driverKind, selection: run.selection, interactionMode: run.interactionMode, permissionMode: run.permissionMode, capabilitySnapshot: run.capabilitySnapshot, context, createdAt: new Date().toISOString() }, controller.signal).then(() => 'released', () => 'withheld');
    try { await committed.promise; if (change === 'abort') controller.abort(); else clock = new Date(clock.getTime() + 120_000); }
    finally { release.resolve(); spy.mockRestore(); }
    expect(await pending).toBe('withheld'); expect(sink).not.toHaveBeenCalled(); expect(await inspectQueue()).toMatchObject({ revision: 1 });
  });
  it('retains mixed origins with the earliest explicit source deadline', async () => {
    const first = await mark(); const expiry = future(60_000);
    await mark({ googleAccountId: '10000000-0000-4000-8000-000000000002', consentId: 'second', expiresAt: expiry, expectedRevision: first.revision });
    await enqueue(); expect((await inspectQueue())?.origins).toHaveLength(2); expect((await inspectQueue())?.retentionDeadline).toBe(expiry);
  });
  it('validates actual idempotent queue identity rather than only the newly requested ID', async () => {
    await mark(); const result = await enqueue(); await repository.kysely.deleteFrom('google_copy_registry').where('entity_ref', '=', queueContextEntityRef('qturn_one')).execute();
    await expect(repository.enqueueQueuedTurn(owner, { ...result.queuedTurn, queuedTurnId: 'qturn_other', baseRevision: (await repository.get(owner, key.chatId))!.chat.revision,
      clientRequestId: 'req_qturn_one', createdAt: new Date().toISOString() })).rejects.toThrow();
    expect(await inspectQueue()).toBeNull(); expect(await inspectQueue('qturn_other')).toBeNull();
  });
  it('does not return oversized persisted context bodies from SQL', async () => {
    await mark(); const admitted = await enqueue(); await sql`UPDATE chat_queued_turns SET context_snapshot=jsonb_set(context_snapshot,'{chats,0,text}',to_jsonb(repeat('x',100000)))`.execute(repository.kysely);
    let bounded = false; const db = repository.kysely.withPlugin({ transformQuery(args) { return args.node; }, async transformResult(args) {
      for (const row of args.result.rows) if ('has_context' in row && 'canonical' in row && 'context' in row) { expect(row.context).toBeNull(); expect(row.canonical).toBeNull(); bounded = true; } return args.result;
    } });
    const repo = new ChatRepository(db, false, undefined, { ...options, contextWrites: snapshotAdapter });
    await expect(repo.enqueueQueuedTurn(owner, { ...admitted.queuedTurn, queuedTurnId: 'qturn_one', clientRequestId: 'req_qturn_one', baseRevision: 2, createdAt: new Date().toISOString() })).rejects.toThrow(); expect(bounded).toBe(true); expect((await inspectQueue())?.revision).toBe(1);
  });
  it('preserves exact context and durable marker when deletion waits on a row and is cancelled', async () => {
    await mark(); await enqueue(); const copy = (await inspectQueue())!;
    await repository.cancelQueuedTurn(owner, { chatId: key.chatId, queuedTurnId: 'qturn_one', clientRequestId: 'req_cancel', baseRevision: (await repository.get(owner, key.chatId))!.chat.revision, cancelledAt: new Date().toISOString() });
    const controller = new AbortController(); let pending!: Promise<string>;
    await repository.kysely.transaction().execute(async held => {
      await held.selectFrom('chat_queued_turns').select('id').forUpdate().execute();
      pending = snapshotAdapter.delete({ ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: controller.signal }).then(() => 'deleted', () => 'denied');
      await new Promise(resolve => setTimeout(resolve, 30)); controller.abort();
    });
    expect(await pending).toBe('denied'); const row = (await sql<{ context_snapshot: unknown; google_context_redacted_hash: unknown }>`SELECT context_snapshot,google_context_redacted_hash FROM chat_queued_turns`.execute(repository.kysely)).rows[0]!;
    expect(row.context_snapshot).toEqual(context); expect(row.google_context_redacted_hash).toBeNull();
  });
  it('does not infer quiescence for a claimed queue row missing its actual run binding', async () => {
    await mark(); await enqueue(); const copy = (await inspectQueue())!;
    await repository.kysely.updateTable('chat_queued_turns').set({ status: 'claimed' }).where('id', '=', 'qturn_one').execute();
    const adapter = createGoogleContextSnapshotAdapter(repository.kysely, { queueAdmission: { async withStoppedQueue(_target, work) { return work(); } } });
    await expect(adapter.quiesceCopy(owner.ownerId, copy.entityRef)).rejects.toThrow();
    expect(await adapter.delete({ ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: new AbortController().signal })).toEqual({ status: 'unavailable' });
  });
});

describe('context worker races and retry settlement', () => {
  it('does not take a chat lock while waiting for the purge worker queue-copy lock', async () => {
    const source = await mark(); await enqueue(); await repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() });
    await provenance.requestPurge(owner.ownerId, source.sources[0]!.originId, 'request'); const claim = (await provenance.claimPurge('worker'))!;
    const entered = deferred(); const proceed = deferred(); const attempted = deferred();
    const db = repository.kysely.withPlugin({ transformQuery(args) { if (JSON.stringify(args.node).includes('ORDER BY entity_ref FOR UPDATE')) attempted.resolve(); return args.node; }, async transformResult(args) { return args.result; } });
    const repo = new ChatRepository(db, false, undefined, { ...options, contextWrites: snapshotAdapter });
    const deleting = provenance.executeClaim(claim, { derived: async () => { entered.resolve(); await proceed.promise;
      await repository.kysely.transaction().execute(async tx => { await sql`SET LOCAL lock_timeout='500ms'`.execute(tx); await tx.selectFrom('chats').select('id').where('id', '=', key.chatId).forUpdate().execute(); });
      return { status: 'unavailable' }; } });
    await entered.promise; const writing = repo.claimNextQueuedTurn(owner, { chatId: key.chatId, turnId: 'cturn_claimed', runId: 'run_claimed', messageId: 'msg_claimed', claimedAt: new Date().toISOString() }).then(() => 'claimed', () => 'denied');
    try { await attempted.promise; } finally { proceed.resolve(); }
    expect(await deleting).toBe('unresolved'); expect(await writing).toBe('denied'); expect(await inspectRun('run_claimed')).toBeNull();
  });
  it('rejects candidate changes during the copy lock wait without certifying an opaque queued row', async () => {
    await mark(); await enqueue(); await repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() });
    const attempted = deferred(); const db = repository.kysely.withPlugin({ transformQuery(args) { if (JSON.stringify(args.node).includes('ORDER BY entity_ref FOR UPDATE')) attempted.resolve(); return args.node; }, async transformResult(args) { return args.result; } });
    const repo = new ChatRepository(db, false, undefined, { ...options, contextWrites: snapshotAdapter }); let pending!: Promise<string>;
    await repository.kysely.transaction().execute(async held => {
      await sql`SELECT id FROM google_copy_registry FOR UPDATE`.execute(held);
      pending = repo.claimNextQueuedTurn(owner, { chatId: key.chatId, turnId: 'cturn_claimed', runId: 'run_claimed', messageId: 'msg_claimed', claimedAt: new Date().toISOString() }).then(() => 'claimed', () => 'denied');
      await attempted.promise;
      await sql`INSERT INTO chat_queued_turns (id,chat_id,client_request_id,position,status,parts,driver_kind,instance_id,selection,interaction_mode,permission_mode,capability_snapshot,context_snapshot,created_at,updated_at)
        SELECT 'qturn_opaque',chat_id,'req_opaque',2,'queued',parts,driver_kind,instance_id,selection,interaction_mode,permission_mode,capability_snapshot,context_snapshot,created_at,updated_at FROM chat_queued_turns WHERE id='qturn_one'`.execute(repository.kysely);
    });
    expect(await pending).toBe('denied'); expect(await inspectQueue('qturn_opaque')).toBeNull(); expect(await inspectRun('run_claimed')).toBeNull();
  });
  it('retains exact-hash idempotency after cancellation during redaction COMMIT', async () => {
    await mark(); await enqueue(); const copy = (await inspectQueue())!;
    await repository.cancelQueuedTurn(owner, { chatId: key.chatId, queuedTurnId: 'qturn_one', clientRequestId: 'req_cancel', baseRevision: (await repository.get(owner, key.chatId))!.chat.revision, cancelledAt: new Date().toISOString() });
    const controller = new AbortController(); const committed = deferred(); const release = deferred(); const transaction = repository.kysely.transaction.bind(repository.kysely);
    const spy = vi.spyOn(repository.kysely, 'transaction').mockImplementation(() => { const builder = transaction(); const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(async work => { const result = await execute(work); committed.resolve(); await release.promise; return result; }); return builder; });
    const args = { ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: controller.signal };
    const deleting = snapshotAdapter.delete(args).then(() => 'deleted', () => 'denied');
    try { await committed.promise; controller.abort(); } finally { release.resolve(); spy.mockRestore(); }
    expect(await deleting).toBe('denied'); expect(await snapshotAdapter.delete({ ...args, signal: new AbortController().signal })).toEqual({ status: 'deleted' });
  });
  it('reports physical queue removal idempotently after an actual owner Chat cascade', async () => {
    await mark(); await enqueue(); const copy = (await inspectQueue())!;
    await repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'completed', completedAt: new Date().toISOString() });
    await repository.hardDelete(owner, { chatId: key.chatId, clientRequestId: 'req_delete_owner_chat' });
    expect(await snapshotAdapter.delete({ ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: new AbortController().signal })).toEqual({ status: 'missing' });
  });
});
