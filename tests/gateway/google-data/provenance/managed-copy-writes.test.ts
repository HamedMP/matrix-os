import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { bootstrapBotDatabase, type OwnerBotDatabase } from '../../../../packages/gateway/src/bots/database.js';
import { ChatRepository } from '../../../../packages/gateway/src/chat/repository.js';
import { createManagedPiSessionsRepository } from '../../../../packages/gateway/src/chat/managed-pi-sessions.js';
import { createGoogleModelHistoryStore } from '../../../../packages/gateway/src/google-data/runtime/model-history.js';
import { createGoogleContextStore } from '../../../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleProvenanceStore } from '../../../../packages/gateway/src/google-data/provenance/store.js';
import { createGoogleManagedPiCopyHooks, createGoogleManagedPiSessionDeletionHandler,
  managedPiSessionEntityRef } from '../../../../packages/gateway/src/google-data/provenance/managed-copy-writes.js';
import { createAuthorityFixture } from '../fixture-db.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const account = '10000000-0000-4000-8000-000000000001';
const otherAccount = '10000000-0000-4000-8000-000000000002';
const key = { ownerId: owner.ownerId, chatId: 'chat_saved' };
const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
let db: Kysely<OwnerBotDatabase>;
let chat: ChatRepository;
let sessions: ReturnType<typeof createManagedPiSessionsRepository>;
let contexts: ReturnType<typeof createGoogleContextStore>;
let provenance: ReturnType<typeof createGoogleProvenanceStore>;
const request = (baseRevision = 0) => ({ ...key, baseRevision, messages: [{ role: 'toolResult', content: [{ type: 'text', text: 'synthetic mailbox content' }] }],
  compactedThroughSeq: 0, tokenEstimate: 12, runtimeVersions: { pi: '1.0' }, now: new Date().toISOString() });
const inspectCopy = () => provenance.inspect(key.ownerId, 'session', managedPiSessionEntityRef(key.chatId));
async function mark(extra: Record<string, unknown> = {}) {
  return contexts.mark({ ...key, googleAccountId: account, consentId: 'consent_one', profileId: 'managed', profileRevision: 1,
    purposeId: 'assistant', expiresAt: future(), retentionDeadline: future(), ...extra });
}
beforeEach(async () => {
  const fixture = await createAuthorityFixture();
  db = fixture.db.sql as unknown as Kysely<OwnerBotDatabase>;
  chat = new ChatRepository(db);
  await chat.bootstrap();
  await bootstrapBotDatabase(db);
  const history = createGoogleModelHistoryStore(db);
  await history.migrate();
  chat = new ChatRepository(db, false, undefined, { onServerCreatedEmptyChat: (tx, subject, chatId, receipt) =>
    history.recordServerCreatedEmptyChat(tx, subject, chatId, receipt) });
  await chat.create(owner, { id: key.chatId, clientRequestId: 'req_saved', title: 'Saved cache' });
  contexts = createGoogleContextStore(db);
  provenance = createGoogleProvenanceStore(db);
  await provenance.migrate();
  sessions = createManagedPiSessionsRepository(db, createGoogleManagedPiCopyHooks());
});

describe('atomic Google-derived managed Pi copies', () => {
  it('adopts only an exact cache saved while its trusted history was ordinary', async () => {
    await sessions.save({ ...request(), messages: [{ role: 'user', content: 'Please read my mail' }] });
    expect(await inspectCopy()).toBeNull();
    await mark();
    expect((await sessions.load(key)).messages).toEqual([{ role: 'user', content: 'Please read my mail' }]);
    expect((await inspectCopy())?.state).toBe('active');
    await sessions.save(request(1));
    expect((await inspectCopy())?.revision).toBe(2);
  });
  it('refuses an ordinary cache modified outside the receipt-bearing writer before collection', async () => {
    await sessions.save({ ...request(), messages: [{ role: 'user', content: 'Ordinary' }] });
    await sql`UPDATE managed_pi_sessions SET messages='[{"role":"user","content":"unproven modification"}]'::jsonb WHERE chat_id=${key.chatId}`.execute(db);
    await mark();
    await expect(sessions.load(key)).rejects.toThrow();
    await expect(sessions.save(request(1))).rejects.toThrow();
    expect(await inspectCopy()).toBeNull();
  });
  it('registers first content and every later CAS revision with durable exact lineage', async () => {
    const context = await mark();
    expect(await sessions.save(request())).toEqual({ revision: 1 });
    const first = await inspectCopy();
    expect(first).toMatchObject({ kind: 'session', entityRef: managedPiSessionEntityRef(key.chatId), state: 'active', revision: 1,
      retentionDeadline: context.retentionDeadline, origins: [{ connectionId: context.sources[0]!.originId,
        profileId: 'managed', profileRevision: 1, purpose: 'assistant' }] });
    expect(JSON.stringify(first)).not.toContain('synthetic mailbox');
    expect((await sessions.load(key)).messages).toEqual(request().messages);
    await sessions.save({ ...request(1), messages: [{ role: 'assistant', content: 'derived summary' }] });
    expect((await inspectCopy())?.contentHash).not.toBe(first?.contentHash);
    expect((await inspectCopy())?.revision).toBe(2);
  });
  it('keeps all mixed origins and the earliest explicit context retention deadline', async () => {
    const deadline = future(20_000);
    const first = await mark({ retentionDeadline: deadline });
    await mark({ googleAccountId: otherAccount, consentId: 'consent_two', expectedRevision: first.revision });
    await sessions.save(request());
    expect(await inspectCopy()).toMatchObject({ retentionDeadline: deadline, origins: expect.any(Array) });
    expect((await inspectCopy())?.origins).toHaveLength(2);
  });
  it('rolls content and registry back together in a caller transaction', async () => {
    await mark();
    await expect(db.transaction().execute(async tx => {
      await sessions.save(request(), tx);
      expect(await createGoogleProvenanceStore(tx).inspect(key.ownerId, 'session', managedPiSessionEntityRef(key.chatId))).not.toBeNull();
      throw new Error('cancel transaction');
    })).rejects.toThrow('cancel transaction');
    expect(await inspectCopy()).toBeNull();
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(0);
  });
  it('rolls back the session write when provenance admission fails', async () => {
    const context = await mark();
    await provenance.requestPurge(key.ownerId, context.sources[0]!.originId, 'purge_before_first_save');
    await expect(sessions.save(request())).rejects.toThrow();
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(0);
    expect(await inspectCopy()).toBeNull();
  });
  it('rejects stale content CAS without changing the registered hash', async () => {
    await mark();
    await sessions.save(request());
    const copy = await inspectCopy();
    await expect(sessions.save(request())).rejects.toThrow();
    expect(await inspectCopy()).toEqual(copy);
  });
  it('hashes JSONB object keys canonically, including nested message and runtime metadata', async () => {
    await mark();
    await sessions.save({ ...request(), messages: [{ z: 1, a: { y: 'y', b: 'b' }, role: 'toolResult' }], runtimeVersions: { z: '1', a: '2' } });
    await sql`UPDATE managed_pi_sessions SET messages='[{"role":"toolResult","a":{"b":"b","y":"y"},"z":1}]'::jsonb,
      runtime_versions='{"a":"2","z":"1"}'::jsonb WHERE owner_id=${key.ownerId} AND chat_id=${key.chatId}`.execute(db);
    expect((await sessions.load(key)).revision).toBe(1);
  });
  it('uses exact JSONB numeric text rather than losing modified precision through JavaScript', async () => {
    await mark();
    await sessions.save({ ...request(), messages: [{ role: 'toolResult', value: 100000000000000000000 }] });
    await sql`UPDATE managed_pi_sessions SET messages='[{"role":"toolResult","value":100000000000000000001}]'::jsonb
      WHERE owner_id=${key.ownerId} AND chat_id=${key.chatId}`.execute(db);
    await expect(sessions.load(key)).rejects.toThrow();
    const copy = (await inspectCopy())!;
    expect(await createGoogleManagedPiSessionDeletionHandler(db)({ ownerId: key.ownerId, entityRef: copy.entityRef,
      expectedHash: copy.contentHash, signal: new AbortController().signal })).toEqual({ status: 'modified' });
  });
  it('pins the session request fields before awaiting lineage locks', async () => {
    await mark();
    await chat.create(owner, { id: 'chat_other', clientRequestId: 'req_other', title: 'Other' });
    await mark({ chatId: 'chat_other' });
    const pendingInput = request();
    let saving!: ReturnType<typeof sessions.save>;
    await db.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      try {
        saving = sessions.save(pendingInput);
        pendingInput.chatId = 'chat_other';
        await sql`SELECT pg_advisory_unlock(551035504)`.execute(held);
        expect(await saving).toEqual({ revision: 1 });
      } finally { await sql`SELECT pg_advisory_unlock_all()`.execute(held); }
    });
    expect((await sessions.load(key)).revision).toBe(1);
    expect((await createManagedPiSessionsRepository(db).load({ ...key, chatId: 'chat_other' })).revision).toBe(0);
  });
  it('serializes concurrent saves so only one exact content CAS and copy update commits', async () => {
    await mark();
    await sessions.save(request());
    const results = await Promise.allSettled([sessions.save({ ...request(1), messages: [{ role: 'assistant', content: 'a' }] }),
      sessions.save({ ...request(1), messages: [{ role: 'assistant', content: 'b' }] })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await sessions.load(key)).revision).toBe(2);
    expect((await inspectCopy())?.revision).toBe(2);
  });
  it('denies missing, altered or expired copy metadata before returning Google content', async () => {
    await mark();
    await sessions.save(request());
    await sql`UPDATE managed_pi_sessions SET messages='[{"role":"assistant","content":"changed"}]'::jsonb
      WHERE owner_id=${key.ownerId} AND chat_id=${key.chatId}`.execute(db);
    await expect(sessions.load(key)).rejects.toThrow();
    await expect(sessions.save(request(1))).rejects.toThrow();
    await sql`DELETE FROM google_copy_registry WHERE owner_id=${key.ownerId}`.execute(db);
    await expect(sessions.load(key)).rejects.toThrow();
  });
  it('does not fabricate lineage for existing unregistered Google cache rows or historical chats', async () => {
    await mark();
    await createManagedPiSessionsRepository(db).save(request());
    await expect(sessions.load(key)).rejects.toThrow();
    await expect(sessions.save(request(1))).rejects.toThrow();
    await new ChatRepository(db).create(owner, { id: 'chat_unknown', clientRequestId: 'req_unknown', title: 'Legacy' });
    await expect(sessions.load({ ...key, chatId: 'chat_unknown' })).rejects.toThrow();
  });
  it('leaves ordinary born chats and uninstalled repository behavior unchanged', async () => {
    await sessions.save({ ...request(), messages: [{ role: 'user', content: 'ordinary' }] });
    expect((await sessions.load(key)).revision).toBe(1);
    expect(await inspectCopy()).toBeNull();
    await new ChatRepository(db).create(owner, { id: 'chat_legacy', clientRequestId: 'req_legacy', title: 'Legacy' });
    const legacy = createManagedPiSessionsRepository(db);
    await legacy.save({ ...request(), chatId: 'chat_legacy' });
    expect((await legacy.load({ ...key, chatId: 'chat_legacy' })).revision).toBe(1);
  });
  it('denies a closed context even if content and its hash remain present', async () => {
    await mark();
    await sessions.save(request());
    await contexts.beginPurge(key.ownerId, account);
    await expect(sessions.load(key)).rejects.toThrow();
    await expect(sessions.save(request(1))).rejects.toThrow();
  });
  it('denies expired retained-copy metadata even with an available Google context', async () => {
    await mark();
    await sessions.save(request());
    await sql`UPDATE google_copy_registry SET retention_deadline=clock_timestamp()-interval '1 second' WHERE owner_id=${key.ownerId}`.execute(db);
    await expect(sessions.load(key)).rejects.toThrow();
    await expect(sessions.save(request(1))).rejects.toThrow();
  });
  it('revalidates context expiry after a real provenance-copy lock wait', async () => {
    await mark({ expiresAt: future(300) });
    await sessions.save(request());
    let pending!: Promise<string>;
    await db.transaction().execute(async held => {
      await sql`SELECT id FROM google_copy_registry WHERE owner_id=${key.ownerId} FOR UPDATE`.execute(held);
      pending = sessions.load(key).then(() => 'released', () => 'denied');
      await new Promise(resolve => setTimeout(resolve, 350));
    });
    expect(await pending).toBe('denied');
  });
  it('rolls back content and registration when retention expires after the final registry write', async () => {
    const deadline = future(1000);
    await mark({ retentionDeadline: deadline });
    let now = new Date();
    const delayed = db.withPlugin({ transformQuery: args => args.node, async transformResult(args) {
      if (args.result.rows[0] && 'content_hash' in args.result.rows[0]) now = new Date(Date.now() + 2000);
      return args.result;
    } });
    const guarded = createManagedPiSessionsRepository(delayed, createGoogleManagedPiCopyHooks({ now: () => now }));
    await expect(guarded.save(request())).rejects.toThrow();
    expect(await inspectCopy()).toBeNull();
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(0);
  });
  it('denies cross-owner load/save without modifying the correct owner copy', async () => {
    await mark();
    await sessions.save(request());
    const copy = await inspectCopy();
    await expect(sessions.load({ ...key, ownerId: 'other_owner' })).rejects.toThrow();
    await expect(sessions.save({ ...request(1), ownerId: 'other_owner' })).rejects.toThrow();
    expect(await inspectCopy()).toEqual(copy);
  });
  it('honors cancellation before admission and after awaited content CAS by rolling both writes back', async () => {
    await mark();
    await expect(sessions.save(request(), db, AbortSignal.abort())).rejects.toThrow();
    const controller = new AbortController();
    const aborting = db.withPlugin({ transformQuery: args => args.node, async transformResult(args) {
      if (args.result.rows[0] && Object.keys(args.result.rows[0]).join() === 'revision') controller.abort();
      return args.result;
    } });
    await expect(sessions.save(request(), aborting, controller.signal)).rejects.toThrow();
    expect(await inspectCopy()).toBeNull();
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(0);
  });
});

describe('owned immutable-hash Pi cache deletion', () => {
  it('deletes only the matching owner cache and is idempotent, preserving canonical owner messages', async () => {
    await mark();
    await sessions.save(request());
    await sql`INSERT INTO chat_messages(id,chat_id,seq,role,state,purpose,parts,byte_count,created_at)
      VALUES('msg_owner',${key.chatId},1,'user','committed','ai_request','[{"type":"text","text":"keep owner words"}]'::jsonb,46,now())`.execute(db);
    const copy = (await inspectCopy())!;
    const handler = createGoogleManagedPiSessionDeletionHandler(db);
    const deletion = { ownerId: key.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: new AbortController().signal };
    expect(await handler({ ...deletion, ownerId: 'outsider' })).toEqual({ status: 'missing' });
    expect(await handler(deletion)).toEqual({ status: 'deleted' });
    expect(await handler(deletion)).toEqual({ status: 'missing' });
    expect((await db.selectFrom('chat_messages').select('id').where('id', '=', 'msg_owner').execute())).toHaveLength(1);
  });
  it('preserves modified rows and revision-only changes as unresolved', async () => {
    await mark();
    await sessions.save(request());
    const copy = (await inspectCopy())!;
    await sql`UPDATE managed_pi_sessions SET revision=revision+1 WHERE owner_id=${key.ownerId} AND chat_id=${key.chatId}`.execute(db);
    expect(await createGoogleManagedPiSessionDeletionHandler(db)({ ownerId: key.ownerId, entityRef: copy.entityRef,
      expectedHash: copy.contentHash, signal: new AbortController().signal })).toEqual({ status: 'modified' });
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(2);
  });
  it('settles the actual provenance worker receipt after the cache-only handler', async () => {
    const context = await mark();
    await sessions.save(request());
    const receipt = await provenance.requestPurge(key.ownerId, context.sources[0]!.originId, 'request');
    const claim = (await provenance.claimPurge('worker'))!;
    expect(await provenance.executeClaim(claim, { session: createGoogleManagedPiSessionDeletionHandler(db) })).toBe('deleted');
    expect(await provenance.status(key.ownerId, receipt.id)).toMatchObject({ complete: true, deleted: 1, coverage: 'registered-copies-only' });
    await expect(sessions.save(request())).rejects.toThrow();
  });
  it('does not deadlock a copy-locked purge worker against a competing save', async () => {
    const context = await mark();
    await sessions.save(request());
    await provenance.requestPurge(key.ownerId, context.sources[0]!.originId, 'request');
    const claim = (await provenance.claimPurge('worker'))!;
    let entered!: () => void;
    const handlerEntered = new Promise<void>(resolve => { entered = resolve; });
    let deleting!: ReturnType<typeof provenance.executeClaim>;
    let saving!: Promise<string>;
    await db.transaction().execute(async held => {
      await held.selectFrom('managed_pi_sessions').select('revision').where('owner_id', '=', key.ownerId).where('chat_id', '=', key.chatId).forUpdate().execute();
      const handler = createGoogleManagedPiSessionDeletionHandler(db);
      deleting = provenance.executeClaim(claim, { session: async args => { entered(); return handler(args); } });
      await handlerEntered;
      saving = sessions.save(request(1)).then(() => 'saved', () => 'denied');
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(await deleting).toBe('deleted');
    expect(await saving).toBe('denied');
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(0);
  });
  it('rolls deletion back if cancellation arrives after the conditional DELETE', async () => {
    await mark();
    await sessions.save(request());
    const copy = (await inspectCopy())!;
    const controller = new AbortController();
    const cancelling = db.withPlugin({ transformQuery: args => args.node, async transformResult(args) {
      if (args.result.rows[0] && Object.keys(args.result.rows[0]).join() === 'session_id') controller.abort();
      return args.result;
    } });
    expect(await createGoogleManagedPiSessionDeletionHandler(cancelling)({ ownerId: key.ownerId, entityRef: copy.entityRef,
      expectedHash: copy.contentHash, signal: controller.signal })).toEqual({ status: 'unavailable' });
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(1);
  });
  it('honors cancellation during a content-row lock wait without deleting after it resolves', async () => {
    await mark();
    await sessions.save(request());
    const copy = (await inspectCopy())!;
    const controller = new AbortController();
    let result!: Promise<unknown>;
    await db.transaction().execute(async held => {
      await held.selectFrom('managed_pi_sessions').select('revision').where('chat_id', '=', key.chatId).forUpdate().execute();
      result = createGoogleManagedPiSessionDeletionHandler(db)({ ownerId: key.ownerId, entityRef: copy.entityRef, expectedHash: copy.contentHash, signal: controller.signal });
      await new Promise(resolve => setTimeout(resolve, 30));
      controller.abort();
    });
    expect(await result).toEqual({ status: 'unavailable' });
    expect((await createManagedPiSessionsRepository(db).load(key)).revision).toBe(1);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
describe('post-COMMIT Pi copy release', () => {
  it.each((['load', 'save'] as const).flatMap(mode =>
    (['abort', 'context-retention', 'source-expiry', 'copy-retention', 'invalid-clock'] as const).map(change => [mode, change] as const)))
  ('withholds %s after %s during the actual COMMIT-return window', async (mode, change) => {
      // One fresh chat per case; actual PostgreSQL commit runs before the deferred return.
      const suffix = change.replaceAll('-', '_');
      const subject = { ...key, chatId: `chat_commit_${mode}_${suffix}` };
      await chat.create(owner, { id: subject.chatId, clientRequestId: `req_commit_${mode}_${suffix}`, title: 'Commit window' });
      let clock = new Date();
      const short = new Date(clock.getTime() + 60_000).toISOString();
      const long = new Date(clock.getTime() + 3_600_000).toISOString();
      await mark({ chatId: subject.chatId, expiresAt: change === 'source-expiry' ? short : long,
        retentionDeadline: change === 'context-retention' ? short : long });
      const guarded = createManagedPiSessionsRepository(db, createGoogleManagedPiCopyHooks({ now: () => clock }));
      await guarded.save({ ...request(), ...subject });
      if (change === 'copy-retention') await sql`UPDATE google_copy_registry SET retention_deadline=${short}::timestamptz
        WHERE owner_id=${subject.ownerId} AND entity_ref=${managedPiSessionEntityRef(subject.chatId)}`.execute(db);
      const committed = deferred();
      const release = deferred();
      const transact = db.transaction.bind(db);
      let transactions = 0;
      const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(() => {
        transactions++;
        const builder = transact();
        const execute = builder.execute.bind(builder);
        vi.spyOn(builder, 'execute').mockImplementation(async work => {
          const value = await execute(work);
          committed.resolve();
          await release.promise;
          return value;
        });
        return builder;
      });
      const controller = new AbortController();
      const pending = mode === 'load' ? guarded.load(subject, db, controller.signal)
        : guarded.save({ ...request(1), ...subject }, db, controller.signal);
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      try {
        await committed.promise;
        if (change === 'abort') controller.abort();
        else clock = change === 'invalid-clock' ? new Date(Number.NaN) : new Date(clock.getTime() + 120_000);
      } finally { release.resolve(); transactionSpy.mockRestore(); }
      expect(await outcome, `${mode}/${change}`).toEqual({ error: expect.any(Error) });
      expect(transactions).toBe(1);
      // A save can already be committed even when its acknowledgement is withheld.
      expect((await createManagedPiSessionsRepository(db).load(subject)).revision).toBe(mode === 'save' ? 2 : 1);
  });
});
