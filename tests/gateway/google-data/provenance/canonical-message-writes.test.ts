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

describe('canonical assistant delta copy writer foundation', () => {
  it('records payload and exact origin atomically without registering owner messages', async () => {
    const context = await mark();
    const message = await repository.appendAssistantDelta(owner, delta());
    expect(message.parts).toEqual([{ type: 'text', text: 'synthetic mail summary' }]);
    const stored = await copy();
    expect(stored).toMatchObject({ kind: 'derived', entityRef: canonicalMessageEntityRef(key.messageId), state: 'active', revision: 1,
      origins: [{ connectionId: context.sources[0]!.originId, profileId: 'managed', profileRevision: 1, purpose: 'assistant' }] });
    expect(JSON.stringify(stored)).not.toContain('synthetic mail');
    const messages = await repository.kysely.selectFrom('chat_messages').select(['id', 'parts', 'seq']).where('chat_id', '=', key.chatId).orderBy('seq').execute();
    expect(messages.map(row => row.id)).toEqual(['msg_user_one', key.messageId]);
    expect(messages[0]!.parts).toEqual([{ type: 'text', text: 'preserve owner words' }]);
    expect((await sql`SELECT 1 FROM google_copy_registry`.execute(repository.kysely)).rows).toHaveLength(1);
  });
  it('updates registered payload hash for streamed append and recovery snapshot, keeping exact prefix replay idempotent', async () => {
    await mark();
    await repository.appendAssistantDelta(owner, delta('hello'));
    const initial = await copy();
    await repository.appendAssistantDelta(owner, delta(' world'));
    expect((await copy())?.contentHash).not.toBe(initial?.contentHash);
    await repository.appendAssistantDelta(owner, { ...delta('hello world!'), snapshot: true });
    const recovered = await copy();
    expect(recovered?.revision).toBe(3);
    await repository.appendAssistantDelta(owner, { ...delta('hello world!'), snapshot: true });
    expect(await copy()).toEqual(recovered);
    await expect(repository.appendAssistantDelta(owner, { ...delta('wrong prefix'), snapshot: true })).rejects.toThrow();
    expect(await copy()).toEqual(recovered);
  });
  it('rolls message, preview, replay projection and provenance back with a caller transaction', async () => {
    await mark();
    const before = await repository.get(owner, key.chatId);
    await expect(repository.withTransaction(async tx => {
      await tx.appendAssistantDelta(owner, delta());
      expect(await createGoogleProvenanceStore(tx.kysely).inspect(owner.ownerId, 'derived', canonicalMessageEntityRef(key.messageId))).not.toBeNull();
      throw new Error('cancel');
    })).rejects.toThrow('cancel');
    expect(await copy()).toBeNull();
    expect(await repository.get(owner, key.chatId)).toEqual(before);
    expect((await repository.kysely.selectFrom('chat_messages').select('id').where('id', '=', key.messageId).execute())).toEqual([]);
  });
  it('rolls all content writes back if a source purge tombstone rejects registration', async () => {
    const context = await mark();
    await provenance.requestPurge(owner.ownerId, context.sources[0]!.originId, 'request');
    await expect(repository.appendAssistantDelta(owner, delta())).rejects.toThrow();
    expect(await copy()).toBeNull();
    expect((await repository.kysely.selectFrom('chat_messages').select('id').where('id', '=', key.messageId).execute())).toEqual([]);
  });
  it('includes encrypted sidecars and rejects changed payload without logging or revealing it', async () => {
    await mark();
    const occurrenceId = assistantCredentialOccurrenceId(key.messageId, 0);
    const envelope = sealAssistantCredential(Buffer.alloc(32, 7), { ownerId: owner.ownerId, ...key, occurrenceId }, 'SYNTHETIC_SECRET');
    await repository.appendAssistantDelta(owner, { ...delta('[redacted]'), credentials: [{ occurrenceId, offset: 0, length: 10, envelope }] });
    expect((await repository.kysely.selectFrom('chat_credentials').select('id').where('message_id', '=', key.messageId).execute())).toHaveLength(1);
    const first = await copy();
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC_SECRET');
    await sql`UPDATE chat_credentials SET revealed=true WHERE id=${occurrenceId}`.execute(repository.kysely);
    await repository.appendAssistantDelta(owner, delta(' more'));
    await sql`UPDATE chat_credentials SET envelope=jsonb_set(envelope,'{data}','"AAAA"'::jsonb) WHERE id=${occurrenceId}`.execute(repository.kysely);
    const before = await copy();
    await expect(repository.appendAssistantDelta(owner, delta(' must not append'))).rejects.toThrow();
    expect(await copy()).toEqual(before);
  });
  it('rejects modified search/parts/byte data before overwrite and rejects existing Google messages without registry', async () => {
    await mark();
    await repository.appendAssistantDelta(owner, delta());
    await sql`UPDATE chat_messages SET search_text='changed search' WHERE id=${key.messageId}`.execute(repository.kysely);
    await expect(repository.appendAssistantDelta(owner, delta(' append'))).rejects.toThrow();
    await sql`DELETE FROM google_copy_registry`.execute(repository.kysely);
    await expect(repository.appendAssistantDelta(owner, delta(' append'))).rejects.toThrow();
  });
  it('rejects unknown or cross-owner history, a foreign/user message id, and closed sources', async () => {
    await expect(repository.appendAssistantDelta({ ...owner, ownerId: 'outsider' }, delta())).rejects.toThrow();
    await new ChatRepository(repository.kysely).create(owner, { id: 'chat_unknown', clientRequestId: 'req_unknown', title: 'Old' });
    await expect(repository.appendAssistantDelta(owner, { ...delta(), chatId: 'chat_unknown' })).rejects.toThrow();
    await mark();
    await expect(repository.appendAssistantDelta(owner, { ...delta(), messageId: 'msg_user_one' })).rejects.toThrow();
    await contexts.beginPurge(owner.ownerId, account);
    await expect(repository.appendAssistantDelta(owner, delta())).rejects.toThrow();
    expect(await copy()).toBeNull();
  });
  it('rejects a published scope even when chats.collaboration remains null', async () => {
    await mark();
    await sql`INSERT INTO collaboration_scopes(id,owner_type,owner_id,kind,resource_id,membership_mode,lifecycle,authority_runtime_id)
      VALUES('10000000-0000-4000-8000-000000000099','personal',${owner.ownerId},'chat',${key.chatId},'direct','shared','runtime_test')`.execute(repository.kysely);
    await expect(repository.appendAssistantDelta(owner, delta())).rejects.toThrow();
    expect(await copy()).toBeNull();
  });
  it('preserves normal uninstalled writes and installs no registry copy for an ordinary born chat', async () => {
    await repository.appendAssistantDelta(owner, delta('ordinary'));
    expect(await copy()).toBeNull();
    const uninstalled = new ChatRepository(repository.kysely);
    await uninstalled.appendAssistantDelta(owner, delta(' legacy'));
    const detail = await repository.getDetailPage(owner, key.chatId, { limit: 20 });
    expect(detail?.messages[1]?.parts).toEqual([{ type: 'text', text: 'ordinary legacy' }]);
  });
  it('retains every mixed source and caps copy retention by the earliest source expiry', async () => {
    const first = await mark({ retentionDeadline: future(60_000) });
    const expiry = future(20_000);
    await mark({ googleAccountId: '10000000-0000-4000-8000-000000000002', consentId: 'second',
      expiresAt: expiry, expectedRevision: first.revision });
    await repository.appendAssistantDelta(owner, delta());
    expect((await copy())?.origins).toHaveLength(2);
    expect((await copy())?.retentionDeadline).toBe(expiry);
  });
  it('serializes concurrent streams without losing parts or desynchronizing the copy hash', async () => {
    await mark();
    await Promise.all([repository.appendAssistantDelta(owner, delta('a')), repository.appendAssistantDelta(owner, delta('b'))]);
    const detail = await repository.getDetailPage(owner, key.chatId, { limit: 20 });
    expect(['ab', 'ba']).toContain((detail!.messages[1]!.parts[0] as { text: string }).text);
    expect((await copy())?.revision).toBe(2);
    await repository.appendAssistantDelta(owner, delta('c'));
    expect((await copy())?.revision).toBe(3);
  });
  it('does not take the chat lock while waiting for a purge-owned registry copy lock', async () => {
    const context = await mark();
    await repository.appendAssistantDelta(owner, delta('a'));
    await provenance.requestPurge(owner.ownerId, context.sources[0]!.originId, 'request');
    const claim = (await provenance.claimPurge('worker'))!;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const proceed = new Promise<void>(resolve => { finish = resolve; });
    const deletion = provenance.executeClaim(claim, { derived: async () => { entered(); await proceed;
      await repository.kysely.transaction().execute(async tx => {
        await tx.selectFrom('chats').select('id').where('id', '=', key.chatId).forUpdate().execute();
      });
      return { status: 'unavailable' };
    } });
    await started;
    const writing = repository.appendAssistantDelta(owner, delta('blocked')).then(() => 'written', () => 'denied');
    await new Promise(resolve => setTimeout(resolve, 30));
    finish();
    expect(await deletion).toBe('unresolved');
    expect(await writing).toBe('denied');
  });
  it('rejects cancellation after actual content writes and leaves neither delta nor registration', async () => {
    await mark();
    const controller = new AbortController();
    const cancelling = repository.kysely.withPlugin({ transformQuery: args => args.node, async transformResult(args) {
      if (args.result.rows[0] && 'payload' in args.result.rows[0]) controller.abort();
      return args.result;
    } });
    const repo = new ChatRepository(cancelling, false, undefined, options);
    await expect(repo.appendAssistantDelta(owner, delta(), controller.signal)).rejects.toThrow();
    expect(await copy()).toBeNull();
    expect((await repository.kysely.selectFrom('chat_messages').select('id').where('id', '=', key.messageId).execute())).toEqual([]);
  });
  it('pins owner and request fields before awaiting the context fence', async () => {
    await mark();
    const mutableOwner = { ...owner };
    const input = delta('original');
    let pending!: ReturnType<typeof repository.appendAssistantDelta>;
    await repository.kysely.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      try {
        pending = repository.appendAssistantDelta(mutableOwner, input);
        mutableOwner.ownerId = 'outsider'; input.messageId = 'msg_other'; input.runId = 'run_other'; input.delta = 'changed';
        await sql`SELECT pg_advisory_unlock(551035504)`.execute(held);
        expect(await pending).toMatchObject({ id: key.messageId, parts: [{ type: 'text', text: 'original' }] });
      } finally { await sql`SELECT pg_advisory_unlock_all()`.execute(held); }
    });
    expect((await copy())?.revision).toBe(1);
  });
  it('hashes normalized JSONB and ignores lifecycle timestamp and reveal-only changes', async () => {
    await mark();
    await repository.appendAssistantDelta(owner, delta('same'));
    const before = await copy();
    await sql`UPDATE chat_messages SET parts='[{"text":"same","type":"text"}]'::jsonb,created_at=created_at-interval '1 day'
      WHERE id=${key.messageId}`.execute(repository.kysely);
    await repository.appendAssistantDelta(owner, { ...delta('same'), snapshot: true });
    expect(await copy()).toEqual(before);
  });
  it('rolls back registration if a source expires after its last awaited write', async () => {
    await mark({ expiresAt: future(60_000) });
    let clock = new Date();
    const delayed = repository.kysely.withPlugin({ transformQuery: args => args.node, async transformResult(args) {
      if (args.result.rows[0] && 'content_hash' in args.result.rows[0]) clock = new Date(clock.getTime() + 120_000);
      return args.result;
    } });
    const repo = new ChatRepository(delayed, false, undefined, { ...options, assistantDeltaWrites: createGoogleCanonicalMessageWriteHook({ now: () => clock }) });
    await expect(repo.appendAssistantDelta(owner, delta())).rejects.toThrow();
    expect(await copy()).toBeNull();
    expect((await repository.kysely.selectFrom('chat_messages').select('id').where('id', '=', key.messageId).execute())).toEqual([]);
  });
  it('revalidates expiry after a real registry-lock wait', async () => {
    await mark({ expiresAt: future(300) });
    await repository.appendAssistantDelta(owner, delta('a'));
    let pending!: Promise<string>;
    await repository.kysely.transaction().execute(async held => {
      await sql`SELECT id FROM google_copy_registry FOR UPDATE`.execute(held);
      pending = repository.appendAssistantDelta(owner, delta('b')).then(() => 'written', () => 'denied');
      await new Promise(resolve => setTimeout(resolve, 350));
    });
    expect(await pending).toBe('denied');
    expect((await copy())?.revision).toBe(1);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
describe('canonical delta returned-message release', () => {
  it.each(['abort', 'source-expiry', 'context-expiry', 'copy-expiry', 'invalid-clock'] as const)('withholds acknowledgement after %s during real COMMIT-return', async change => {
    await mark({ expiresAt: future(change === 'source-expiry' ? 60_000 : 240_000), retentionDeadline: future(change === 'context-expiry' ? 60_000 : 240_000) });
    if (change === 'copy-expiry') {
      await repository.appendAssistantDelta(owner, delta('initial'));
      await repository.kysely.updateTable('google_copy_registry').set({ retention_deadline: new Date(Date.now() + 60_000) }).execute();
    }
    let clock = new Date();
    const repo = new ChatRepository(repository.kysely, false, undefined, { ...options,
      assistantDeltaWrites: createGoogleCanonicalMessageWriteHook({ now: () => clock }) });
    const delivered = vi.fn(); repo.registerOutboxSink(delivered);
    const committed = deferred(); const release = deferred();
    const transact = repo.kysely.transaction.bind(repo.kysely);
    let transactions = 0;
    const transactionSpy = vi.spyOn(repo.kysely, 'transaction').mockImplementation(() => {
      transactions++;
      const builder = transact(); const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(async work => {
        const result = await execute(work); committed.resolve(); await release.promise; return result;
      });
      return builder;
    });
    const controller = new AbortController();
    const outcome = repo.appendAssistantDelta(owner, delta(), controller.signal).then(value => ({ value }), error => ({ error }));
    try {
      await committed.promise;
      if (change === 'abort') controller.abort();
      else clock = change === 'invalid-clock' ? new Date(Number.NaN) : new Date(clock.getTime() + 120_000);
    } finally { release.resolve(); transactionSpy.mockRestore(); }
    expect(await outcome).toEqual({ error: expect.any(Error) });
    expect(transactions).toBe(1);
    expect(delivered).not.toHaveBeenCalled();
    expect(await copy()).not.toBeNull(); // The write already committed; only acknowledgement is withheld.
  });
});

describe('canonical delta outer transaction release', () => {
  it('holds all nested events until outer COMMIT and withholds the entire mixed batch on cancellation', async () => {
    await mark();
    const delivered = vi.fn(); repository.registerOutboxSink(delivered);
    const controller = new AbortController();
    await expect(repository.withTransaction(async outer => {
      await outer.appendOutboxEvent(owner, key.chatId, 1, 'chat.updated');
      await outer.withTransaction(async inner => {
        await inner.appendAssistantDelta(owner, delta(), controller.signal);
        expect(delivered).not.toHaveBeenCalled();
      });
      controller.abort();
    })).rejects.toThrow();
    expect(delivered).not.toHaveBeenCalled();
    expect(await copy()).not.toBeNull();
  });
  it('rejects guarded scoped repositories without an actual owning transaction ledger', async () => {
    await mark();
    await expect(repository.kysely.transaction().execute(async tx => {
      const detached = new ChatRepository(tx, true, undefined, options);
      await detached.appendAssistantDelta(owner, delta());
    })).rejects.toThrow();
    expect(await copy()).toBeNull();
  });
});

describe('nested canonical write transaction settlement', () => {
  it.each(['valid', 'expired', 'rollback'] as const)('shares the actual outer COMMIT release boundary: %s', async mode => {
    await mark({ expiresAt: future(60_000) });
    let clock = new Date();
    const checked = vi.fn(() => clock);
    const repo = new ChatRepository(repository.kysely, false, undefined, { ...options,
      assistantDeltaWrites: createGoogleCanonicalMessageWriteHook({ now: checked }) });
    const sink = vi.fn(); repo.registerOutboxSink(sink);
    const committed = deferred(); const release = deferred();
    const transaction = repo.kysely.transaction.bind(repo.kysely);
    const spy = vi.spyOn(repo.kysely, 'transaction').mockImplementation(() => {
      const builder = transaction(); const execute = builder.execute.bind(builder);
      vi.spyOn(builder, 'execute').mockImplementation(async work => {
        const result = await execute(work); committed.resolve(); await release.promise; return result;
      }); return builder;
    });
    const pending = repo.withTransaction(async outer => {
      await outer.appendOutboxEvent(owner, key.chatId, 1, 'chat.updated');
      await outer.withTransaction(inner => inner.appendAssistantDelta(owner, delta()));
      expect(sink).not.toHaveBeenCalled();
      if (mode === 'rollback') { checked.mockClear(); throw new Error('rollback'); }
    }).then(() => 'released', () => 'withheld');
    if (mode === 'rollback') {
      expect(await pending).toBe('withheld'); expect(sink).not.toHaveBeenCalled(); expect(checked).not.toHaveBeenCalled();
      spy.mockRestore(); expect(await copy()).toBeNull(); return;
    }
    try {
      await committed.promise; expect(sink).not.toHaveBeenCalled();
      checked.mockClear();
      if (mode === 'expired') clock = new Date(clock.getTime() + 120_000);
    } finally { release.resolve(); spy.mockRestore(); }
    expect(await pending).toBe(mode === 'valid' ? 'released' : 'withheld');
    expect(checked).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledTimes(mode === 'valid' ? 2 : 0);
    expect(await copy()).not.toBeNull();
  });
});
