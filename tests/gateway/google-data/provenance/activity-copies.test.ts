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

import { createGoogleActivityCopyAdapter, googleActivityEntityRef } from '../../../../packages/gateway/src/google-data/provenance/activity-copies.js';
const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const key = { chatId: 'chat_one', runId: 'run_one', messageId: 'msg_assistant' };
const account = '10000000-0000-4000-8000-000000000001';
const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
const delta = (text = 'synthetic mail summary') => ({ ...key, delta: text, createdAt: new Date().toISOString() });
let repository: ChatRepository;
let activityAdapter: ReturnType<typeof createGoogleActivityCopyAdapter>;
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
  activityAdapter = createGoogleActivityCopyAdapter(repository.kysely); await activityAdapter.migrate();
  repository = new ChatRepository(repository.kysely, false, undefined, { ...options, activityWrites: activityAdapter });
});

const activity = (id = 'activity_one', summary = 'synthetic mail summary') => ({ id, chatId: key.chatId, runId: key.runId,
  occurredAt: new Date().toISOString(), type: 'agent.activity' as const, activityId: `tool_${id}`, kind: 'command' as const,
  label: 'Synthetic command', status: 'running' as const, summary });
const activityCopy = (id = 'activity_one') => provenance.inspect(owner.ownerId, 'derived', googleActivityEntityRef(id));

describe('registered activity copies', () => {
  it('registers exact content and re-registers transitions while preserving stable row sequence', async () => {
    await mark(); const input = activity(); await repository.appendRunActivities(owner, key.chatId, key.runId, [input]);
    const before = await activityCopy(); expect(before).toMatchObject({ state: 'active', revision: 1 });
    expect(JSON.stringify(before)).not.toContain(input.summary);
    await sql`UPDATE chat_run_events SET event=event || '{}'::jsonb`.execute(repository.kysely);
    await repository.appendRunActivities(owner, key.chatId, key.runId, [input]); expect(await activityCopy()).toEqual(before);
    await repository.appendRunActivities(owner, key.chatId, key.runId, [{ ...input, status: 'completed', summary: 'finished synthetic mail' }]);
    const after = await activityCopy(); expect(after?.revision).toBe(2); expect(after?.contentHash).not.toBe(before?.contentHash);
    expect((await repository.kysely.selectFrom('chat_run_events').select('run_seq').executeTakeFirst())?.run_seq).toBe(1);
  });
  it('rolls activity and registry back together and denies missing/modified lineage', async () => {
    await mark();
    await expect(repository.withTransaction(async tx => { await tx.appendRunActivities(owner, key.chatId, key.runId, [activity()]); throw new Error('rollback'); })).rejects.toThrow();
    expect(await activityCopy()).toBeNull(); expect(await repository.kysely.selectFrom('chat_run_events').select('id').execute()).toEqual([]);
    await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]);
    await sql`UPDATE chat_run_events SET event=jsonb_set(event,'{summary}','"modified"')`.execute(repository.kysely);
    await expect(repository.appendRunActivities(owner, key.chatId, key.runId, [{ ...activity(), status: 'completed' }])).rejects.toThrow();
    await provenance.requestPurge(owner.ownerId, (await contexts.inspect(owner.ownerId, key.chatId))!.sources[0]!.originId, 'request');
    expect(await activityAdapter.delete({ ownerId: owner.ownerId, entityRef: googleActivityEntityRef('activity_one'), expectedHash: (await activityCopy())!.contentHash, signal: new AbortController().signal })).toEqual({ status: 'unavailable' });
  });
  it('redacts an inactive run through a real worker, preserves IDs/sequences/owner messages, and is idempotent', async () => {
    const context = await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]); const before = await activityCopy();
    await repository.kysely.updateTable('chat_runs').set({ status: 'completed' }).where('id', '=', key.runId).execute();
    const receipt = await provenance.requestPurge(owner.ownerId, context.sources[0]!.originId, 'request');
    const claim = (await provenance.claimPurge('worker'))!;
    expect(await provenance.executeClaim(claim, { derived: activityAdapter.delete })).toBe('deleted');
    expect(await provenance.status(owner.ownerId, receipt.id)).toMatchObject({ complete: true, deleted: 1 });
    const row = await repository.kysely.selectFrom('chat_run_events').select(['id', 'run_seq', 'event']).executeTakeFirst();
    expect(row).toMatchObject({ id: 'activity_one', run_seq: 1, event: { type: 'run.status', status: 'completed' } });
    expect(JSON.stringify(row)).not.toContain('synthetic mail');
    expect((await repository.kysely.selectFrom('chat_messages').select('parts').where('id', '=', 'msg_user_one').executeTakeFirst())?.parts).toEqual([{ type: 'text', text: 'preserve owner words' }]);
    expect(await activityAdapter.delete({ ownerId: owner.ownerId, entityRef: googleActivityEntityRef('activity_one'), expectedHash: before!.contentHash, signal: new AbortController().signal })).toEqual({ status: 'deleted' });
  });
  it('does not delete a foreign, active, or changed row and honors cancellation', async () => {
    await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]); const before = (await activityCopy())!;
    const args = { ownerId: owner.ownerId, entityRef: before.entityRef, expectedHash: before.contentHash, signal: new AbortController().signal };
    expect(await activityAdapter.delete(args)).toEqual({ status: 'unavailable' });
    expect(await activityAdapter.delete({ ...args, ownerId: 'outsider' })).toEqual({ status: 'missing' });
    await repository.kysely.updateTable('chat_runs').set({ status: 'completed' }).where('id', '=', key.runId).execute();
    await sql`UPDATE chat_run_events SET event=jsonb_set(event,'{summary}','"changed"')`.execute(repository.kysely);
    expect(await activityAdapter.delete(args)).toEqual({ status: 'modified' });
    const controller = new AbortController(); controller.abort();
    await expect(activityAdapter.delete({ ...args, signal: controller.signal })).rejects.toThrow();
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('activity copy lifecycle bounds', () => {
  it('covers terminal binding activity creation through the same pre-content fence', async () => {
    await mark();
    expect(await repository.bindTerminalSession(owner, { chatId: key.chatId, runId: key.runId, sessionId: 'term_synthetic', sessionCreatedAt: new Date().toISOString() })).toBe(true);
    const rows = await repository.kysely.selectFrom('chat_run_events').select(['id', 'event']).execute();
    expect(rows).toHaveLength(1); expect(await activityCopy(rows[0]!.id)).toMatchObject({ revision: 1 });
  });
  it('refuses first-taint certification of preexisting opaque activity', async () => {
    const uninstalled = new ChatRepository(repository.kysely);
    await uninstalled.appendRunActivities(owner, key.chatId, key.runId, [activity()]); await mark();
    await expect(repository.appendRunActivities(owner, key.chatId, key.runId, [activity('activity_new')])).rejects.toThrow();
    expect(await activityCopy()).toBeNull(); expect(await activityCopy('activity_new')).toBeNull();
  });
  it.each(['abort', 'expiry'] as const)('withholds all live content after %s during actual COMMIT-return', async change => {
    await mark({ expiresAt: future(60_000) }); let clock = new Date(); const controller = new AbortController();
    const adapter = createGoogleActivityCopyAdapter(repository.kysely, { now: () => clock });
    const repo = new ChatRepository(repository.kysely, false, undefined, { ...options, activityWrites: adapter });
    const sink = vi.fn(); repo.registerOutboxSink(sink); const committed = deferred(); const release = deferred();
    const transaction = repo.kysely.transaction.bind(repo.kysely);
    const spy = vi.spyOn(repo.kysely, 'transaction').mockImplementation(() => {
      const builder = transaction(); const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(async work => { const result = await execute(work); committed.resolve(); await release.promise; return result; }); return builder;
    });
    const pending = repo.appendRunActivities(owner, key.chatId, key.runId, [activity()], controller.signal).then(() => 'released', () => 'withheld');
    try { await committed.promise; if (change === 'abort') controller.abort(); else clock = new Date(clock.getTime() + 120_000); }
    finally { release.resolve(); spy.mockRestore(); }
    expect(await pending).toBe('withheld'); expect(sink).not.toHaveBeenCalled(); expect(await activityCopy()).not.toBeNull();
  });
  it('keeps a durable idempotency marker when cancellation occurs during deletion COMMIT', async () => {
    await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]); const copy = (await activityCopy())!;
    await repository.kysely.updateTable('chat_runs').set({ status: 'aborted' }).where('id', '=', key.runId).execute();
    const controller = new AbortController(); const committed = deferred(); const release = deferred();
    const transaction = repository.kysely.transaction.bind(repository.kysely);
    const spy = vi.spyOn(repository.kysely, 'transaction').mockImplementation(() => {
      const builder = transaction(); const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(async work => { const result = await execute(work); committed.resolve(); await release.promise; return result; }); return builder;
    });
    const pending = activityAdapter.delete({ ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: controller.signal }).then(() => 'released', () => 'withheld');
    try { await committed.promise; controller.abort(); } finally { release.resolve(); spy.mockRestore(); }
    expect(await pending).toBe('withheld');
    expect(await activityAdapter.delete({ ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: new AbortController().signal })).toEqual({ status: 'deleted' });
  });
  it('tracks bounded eviction and treats removed event copies as idempotently missing', async () => {
    await mark();
    for (let batch = 0; batch < 5; batch++) await repository.appendRunActivities(owner, key.chatId, key.runId,
      Array.from({ length: 100 }, (_, index) => activity(`activity_${String(batch * 100 + index).padStart(3, '0')}`)));
    const evicted = (await activityCopy('activity_000'))!;
    await repository.appendRunActivities(owner, key.chatId, key.runId, [{ id: 'activity_terminal', chatId: key.chatId, runId: key.runId,
      occurredAt: new Date().toISOString(), type: 'run.status', status: 'completed' }]);
    expect(await activityCopy('activity_terminal')).toMatchObject({ revision: 1 });
    expect((await repository.kysely.selectFrom('chat_run_events').select('id').execute())).toHaveLength(500);
    expect(await activityAdapter.delete({ ownerId: owner.ownerId, entityRef: evicted.entityRef, expectedHash: evicted.contentHash, signal: new AbortController().signal })).toEqual({ status: 'missing' });
  }, 40000);
});

describe('activity worker/write concurrency', () => {
  it('allows a real purge worker to take content locks before an activity writer waiting on its later copy', async () => {
    const context = await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity('activity_a'), activity('activity_z')]);
    await repository.kysely.updateTable('chat_runs').set({ status: 'completed' }).where('id', '=', key.runId).execute();
    await provenance.requestPurge(owner.ownerId, context.sources[0]!.originId, 'request');
    const claims = [(await provenance.claimPurge('worker'))!, (await provenance.claimPurge('worker'))!];
    const later = (await sql<{ id: string }>`SELECT j.id FROM google_copy_purge_jobs j JOIN google_copy_registry c ON c.id=j.copy_id WHERE c.entity_ref=${googleActivityEntityRef('activity_z')}`.execute(repository.kysely)).rows[0]!.id;
    const claim = claims.find(item => item.jobId === later)!; const entered = deferred(); const proceed = deferred(); const attempted = deferred();
    const db = repository.kysely.withPlugin({ transformQuery(args) { if (JSON.stringify(args.node).includes('ORDER BY entity_ref FOR UPDATE')) attempted.resolve(); return args.node; }, async transformResult(args) { return args.result; } });
    const repo = new ChatRepository(db, false, undefined, { ...options, activityWrites: activityAdapter });
    const deletion = provenance.executeClaim(claim, { derived: async input => { entered.resolve(); await proceed.promise; return activityAdapter.delete(input); } });
    await entered.promise; const writing = repo.appendRunActivities(owner, key.chatId, key.runId, [activity('activity_new')]).then(() => 'written', () => 'denied');
    try { await attempted.promise; } finally { proceed.resolve(); }
    expect(await deletion).toBe('deleted'); expect(await writing).toBe('denied');
    expect((await activityCopy('activity_z'))?.state).toBe('deleted'); expect(await activityCopy('activity_new')).toBeNull();
  });
  it('cancels redaction after a real event row lock wait without changing content or marker', async () => {
    await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]); const copy = (await activityCopy())!;
    await repository.kysely.updateTable('chat_runs').set({ status: 'completed' }).where('id', '=', key.runId).execute();
    const controller = new AbortController(); let pending!: Promise<string>;
    await repository.kysely.transaction().execute(async held => {
      await held.selectFrom('chat_run_events').select('id').forUpdate().execute();
      pending = activityAdapter.delete({ ownerId: owner.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: controller.signal }).then(() => 'deleted', () => 'denied');
      await new Promise(resolve => setTimeout(resolve, 30)); controller.abort();
    });
    expect(await pending).toBe('denied');
    const row = (await sql<{ event: unknown; google_redacted_hash: unknown }>`SELECT event,google_redacted_hash FROM chat_run_events`.execute(repository.kysely)).rows[0]!;
    expect(JSON.stringify(row.event)).toContain('synthetic mail summary'); expect(row.google_redacted_hash).toBeNull();
  });
});

describe('trusted pre-claim run quiescence', () => {
  it('requires host durable admission and dispatch drain before expiry-safe content-free lifecycle SQL', async () => {
    const context = await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]); const copy = (await activityCopy())!;
    await contexts.beginPurge(owner.ownerId, account);
    await expect(repository.finishRun(owner, { chatId: key.chatId, runId: key.runId, outcome: 'aborted', completedAt: new Date().toISOString() })).rejects.toThrow();
    await expect(activityAdapter.quiesceCopy(owner.ownerId, copy.entityRef)).rejects.toThrow();
    let stopped = false; let released = false;
    const observed = repository.kysely.withPlugin({ transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode') expect(stopped).toBe(true); return args.node;
    }, async transformResult(args) { return args.result; } });
    const adapter = createGoogleActivityCopyAdapter(observed, { quiescence: { async withStoppedRun(target, work) {
      expect(target).toMatchObject({ ownerId: owner.ownerId, chatId: key.chatId, runId: key.runId });
      stopped = true; const result = await work(); expect(released).toBe(false); released = true; return result;
    } } });
    const before = (await repository.kysely.selectFrom('chat_run_events').select('event').executeTakeFirst())!.event;
    expect(await adapter.quiesceCopy(owner.ownerId, copy.entityRef)).toEqual({ quiesced: true, missing: false });
    expect(released).toBe(true); expect((await repository.kysely.selectFrom('chat_run_events').select('event').executeTakeFirst())!.event).toEqual(before);
    expect((await activityCopy())?.contentHash).toBe(copy.contentHash);
    const receipt = await provenance.requestPurge(owner.ownerId, context.sources[0]!.originId, 'request');
    const claim = (await provenance.claimPurge('worker'))!; expect(await provenance.executeClaim(claim, { derived: adapter.delete })).toBe('deleted');
    expect(await provenance.status(owner.ownerId, receipt.id)).toMatchObject({ complete: true });
  });
  it('denies declined admission and never performs lifecycle SQL before cancellation/drain', async () => {
    await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]); const copy = (await activityCopy())!;
    const declined = createGoogleActivityCopyAdapter(repository.kysely, { quiescence: { async withStoppedRun() { return null; } } });
    await expect(declined.quiesceCopy(owner.ownerId, copy.entityRef)).rejects.toThrow();
    const controller = new AbortController();
    const cancelled = createGoogleActivityCopyAdapter(repository.kysely, { quiescence: { async withStoppedRun(_target, work) { controller.abort(); return work(); } } });
    await expect(cancelled.quiesceCopy(owner.ownerId, copy.entityRef, controller.signal)).rejects.toThrow();
    expect((await repository.kysely.selectFrom('chat_runs').select('status').where('id', '=', key.runId).executeTakeFirst())?.status).toBe('accepted');
  });
});

it('rejects oversized persisted payload before its body is returned from PostgreSQL', async () => {
  await mark(); await repository.appendRunActivities(owner, key.chatId, key.runId, [activity()]);
  await sql`UPDATE chat_run_events SET event=jsonb_set(event,'{summary}',to_jsonb(repeat('x',100000)))`.execute(repository.kysely);
  let bounded = false;
  const observed = repository.kysely.withPlugin({ transformQuery(args) { return args.node; }, async transformResult(args) {
    for (const row of args.result.rows) if ('canonical' in row && 'event' in row) { expect(row.event).toBeNull(); expect(row.canonical).toBeNull(); bounded = true; }
    return args.result;
  } });
  const repo = new ChatRepository(observed, false, undefined, { ...options, activityWrites: activityAdapter });
  await expect(repo.appendRunActivities(owner, key.chatId, key.runId, [{ ...activity(), status: 'completed' }])).rejects.toThrow();
  expect(bounded).toBe(true); expect((await activityCopy())?.revision).toBe(1);
});
