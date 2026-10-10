import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createPreviewDriveStore } from '../../packages/platform/src/preview-drive-store.js';

describe('Preview Drive grant store', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('redeems each signed turn proof only once and binds the run', async () => {
    const store = createPreviewDriveStore(db);
    const input = { proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one',
      clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) };
    const results = await Promise.all([store.redeemTurn(input), store.redeemTurn(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const grant = results.find(Boolean)!;
    expect(await store.getRun({ token: grant, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one' }))
      .toMatchObject({ actorId: 'user_owner', turnId: 'cturn_one' });
    expect(await store.getRun({ token: grant, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_other' })).toBeNull();
  });

  it('issues one action grant per signed approval and consumes it atomically once', async () => {
    const store = createPreviewDriveStore(db);
    const runGrant = await store.redeemTurn({ proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) });
    expect(runGrant).toBeTruthy();
    const input = { runGrant: runGrant!, proofNonce: 'c'.repeat(32), proofExpiresAt: Date.now() + 60_000, handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', runId: 'run_one', actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3, connectionId: 'connection-original', providerAccountId: 'pd-original' };
    const [first, duplicate] = await Promise.all([store.issueAction(input), store.issueAction(input)]);
    expect([first, duplicate].filter(Boolean)).toHaveLength(1);
    const actionGrant = first ?? duplicate;
    const executions = await Promise.all([store.consumeAction({ runGrant: runGrant!, grant: actionGrant!,
      handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one', actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3 }),
    store.consumeAction({ runGrant: runGrant!, grant: actionGrant!,
      handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one', actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3 })]);
    expect(executions.filter(Boolean)).toHaveLength(1);
    expect(executions.find(Boolean)).toMatchObject({ actorId: 'user_owner' });
  });

  it('rejects mismatch and expired grants', async () => {
    let now = Date.parse('2026-09-30T00:00:00Z');
    const store = createPreviewDriveStore(db, { now: () => now });
    const runGrant = await store.redeemTurn({ proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) });
    expect(runGrant).toBeTruthy();
    expect(await store.getRun({ token: runGrant!, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one' })).toBeTruthy();
    now += 36 * 60_000;
    expect(await store.getRun({ token: runGrant!, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one' })).toBeNull();
    expect(await store.sweep()).toBeGreaterThan(0);
  });

  it('revokes a completed run and all unused action grants', async () => {
    const store = createPreviewDriveStore(db);
    const runGrant = await store.redeemTurn({ proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) });
    const actionGrant = await store.issueAction({ runGrant: runGrant!, proofNonce: 'c'.repeat(32), proofExpiresAt: Date.now() + 60_000, handle: 'pr-1234',
      actorId: 'user_owner', chatId: 'chat_one', runId: 'run_one', actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3, connectionId: 'connection-original', providerAccountId: 'pd-original' });
    expect(actionGrant).toBeTruthy();
    expect(await store.revokeRun({ token: runGrant!, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one' })).toBe(2);
    expect(await store.consumeAction({ runGrant: runGrant!, grant: actionGrant!, handle: 'pr-1234',
      chatId: 'chat_one', runId: 'run_one', actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3 })).toBeNull();
  });

  it('retains redeemed proof nonces after revocation until their original expiry', async () => {
    let now = Date.parse('2026-10-09T00:00:00Z');
    const store = createPreviewDriveStore(db, { now: () => now });
    const turn = { proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) };
    const token = (await store.redeemTurn(turn))!;
    const key = { token, handle: turn.handle, chatId: turn.chatId, runId: turn.runId };
    expect(await store.revokeRun(key)).toBe(1);
    expect(await store.getRun(key)).toBeNull();
    expect(await store.redeemTurn(turn)).toBeNull();
    expect(await store.sweep()).toBe(0);
    now += 36 * 60_000;
    expect(await store.sweep()).toBe(1);
  });

  it('denies new run admission and action issuance after revocation', async () => {
    const store = createPreviewDriveStore(db);
    const token = (await store.redeemTurn({ proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) }))!;
    const key = { token, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one' };
    expect(await store.withRun(key, async () => 'admitted')).toBe('admitted');
    expect(await store.revokeRun(key)).toBe(1);
    expect(await store.withRun(key, async () => 'must not execute')).toBeNull();
    expect(await store.issueAction({ runGrant: token, proofNonce: 'c'.repeat(32), proofExpiresAt: Date.now() + 60_000, handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', runId: 'run_one', actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3,
      connectionId: 'connection-original', providerAccountId: 'pd-original' })).toBeNull();
  });

  it('rejects legacy action grants without immutable account bindings', async () => {
    const store = createPreviewDriveStore(db);
    const runGrant = (await store.redeemTurn({ proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) }))!;
    const grant = (await store.issueAction({ runGrant, proofNonce: 'c'.repeat(32), proofExpiresAt: Date.now() + 60_000, handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', runId: 'run_one', actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3,
      connectionId: 'connection-original', providerAccountId: 'pd-original' }))!;
    await db.executor.updateTable('preview_drive_grants').set({ connection_id: null, provider_account_id: null }).where('kind', '=', 'action').execute();
    expect(await store.consumeAction({ runGrant, grant, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one',
      actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3 })).toBeNull();
  });
});
