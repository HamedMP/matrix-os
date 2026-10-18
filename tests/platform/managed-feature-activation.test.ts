import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fundedHostActivationRevisionInput } from '@matrix-os/contracts';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createManagedFeatureActivator, createManagedFeatureReconciliationPass } from '../../packages/platform/src/managed-feature-activation.js';

const secret = 'strong-platform-secret-for-test-only';
const at = '2026-10-18T18:00:00.000Z';
const machineId = '12345678-1234-4234-8234-123456789abc';
const relayOrigin = 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app';
describe('managed feature activation page', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId, clerkUserId: 'user_alice', handle: 'alice', runtimeSlot: 'primary', status: 'running', activationState: 'authorized', runtimeTokenEpoch: 2, publicIPv4: '203.0.113.10', provisionedAt: at });
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: true, allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']) }).execute();
    await db.executor.insertInto('ai_funded_runtime_policies').values({ machine_id: machineId, owner_id: 'user_alice', runtime_slot: 'primary', enabled: true, allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']), monthly_budget_microusd: 100, expires_at: null, next_issue_at: at, revision: 1, created_at: at, updated_at: at }).execute();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  it('advances a bounded worker cursor after failures and revisits deferred hosts on the next cycle', async () => {
    const next = '22345678-1234-4234-8234-123456789abc';
    const activate = vi.fn().mockResolvedValueOnce({ activated: 0, failed: 1, complete: false, nextCursor: next })
      .mockResolvedValueOnce({ activated: 1, failed: 0, complete: true, nextCursor: null })
      .mockResolvedValueOnce({ activated: 1, failed: 0, complete: true, nextCursor: null });
    const run = createManagedFeatureReconciliationPass(activate);
    await run(); await run(); await run();
    expect(activate.mock.calls.map(([target]) => target)).toEqual([{}, { afterMachineId: next }, {}]);
  });
  it('reconciles both features after failed activation and verifies the exact loaded revision', async () => {
    let body: unknown;
    let revision: string | null = null;
    const speech = vi.fn(async () => ({ activated: 1, failed: 0 }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'POST') {
        body = JSON.parse(String(options.body));
        revision = createHash('sha256').update(fundedHostActivationRevisionInput(body as never)).digest('hex');
        return Response.json({ status: 'restarting' }, { status: 202 });
      }
      return Response.json({ configured: revision !== null, configurationRevision: revision });
    });
    const activate = createManagedFeatureActivator({ db, platformSecret: secret, relayOrigin, fundedAiEnabled: true, speechEnabled: true, activateSpeech: speech, fetchImpl: fetchImpl as typeof fetch, now: () => new Date(at), wait: async () => {} });
    const result = await activate({});
    expect(result).toMatchObject({ activated: 1, failed: 0, complete: true, nextCursor: null });
    expect(body).toMatchObject({ identity: { machineId, runtimeTokenEpoch: 2 }, configuration: { enabled: true, relayOrigin } });
    expect(speech).toHaveBeenCalledWith({ handle: 'alice' });
    expect(fetchImpl.mock.calls.every(([, o]) => o?.signal instanceof AbortSignal && o.redirect === 'error')).toBe(true);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
  });
  it('retries a failed host independently while continuing speech activation', async () => {
    const speech = vi.fn(async () => ({ activated: 1, failed: 0 }));
    const fetchImpl = vi.fn(async () => { throw new Error('Unavailable'); });
    const activate = createManagedFeatureActivator({ db, platformSecret: secret, relayOrigin, fundedAiEnabled: true, speechEnabled: true, activateSpeech: speech, fetchImpl, now: () => new Date(at), wait: async () => {} });
    expect(await activate({})).toMatchObject({ activated: 0, failed: 1 });
    expect(speech).toHaveBeenCalledTimes(1);
    expect(await activate({})).toMatchObject({ failed: 1 });
    expect(speech).toHaveBeenCalledTimes(2);
  });
  it('bounds pages and concurrency while isolating a host failure and completing later pages', async () => {
    for (let index = 1; index <= 9; index += 1) await insertUserMachine(db, {
      machineId: `22345678-1234-4234-8234-${String(index).padStart(12, '0')}`, clerkUserId: `user_host_${index}`,
      handle: `host-${index}`, runtimeSlot: 'primary', status: 'running', activationState: 'authorized', provisionedAt: at,
    });
    let active = 0, maximum = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const speech = vi.fn(async ({ handle }: { handle: string }) => {
      active += 1; maximum = Math.max(maximum, active);
      try {
        await barrier;
        if (handle === 'host-2') throw new Error('Unavailable host');
        return { activated: 1, failed: 0 };
      } finally { active -= 1; }
    });
    const activate = createManagedFeatureActivator({ db, platformSecret: secret, relayOrigin, fundedAiEnabled: false, speechEnabled: true, activateSpeech: speech });
    const pending = activate({});
    await vi.waitFor(() => expect(speech).toHaveBeenCalledTimes(4));
    expect(maximum).toBe(4);
    release();
    const first = await pending;
    expect(first).toEqual({ activated: 7, failed: 1, complete: false, nextCursor: '22345678-1234-4234-8234-000000000007' });
    expect(speech).toHaveBeenCalledTimes(8);
    expect(maximum).toBe(4);
    expect(await activate({ afterMachineId: first.nextCursor! })).toEqual({ activated: 2, failed: 0, complete: true, nextCursor: null });
    expect(speech).toHaveBeenCalledTimes(10);
    expect(new Set(speech.mock.calls.map(([target]) => target.handle)).size).toBe(10);
  });
  it('does not enable AI without policy and respects feature kill switches', async () => {
    await db.executor.deleteFrom('ai_funded_runtime_policies').execute();
    const fetchImpl = vi.fn();
    const speech = vi.fn(async () => ({ activated: 1, failed: 0 }));
    const activate = createManagedFeatureActivator({ db, platformSecret: secret, relayOrigin, fundedAiEnabled: true, speechEnabled: true, activateSpeech: speech, fetchImpl, now: () => new Date(at) });
    expect(await activate({})).toMatchObject({ activated: 1, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const disabled = createManagedFeatureActivator({ db, platformSecret: secret, relayOrigin: '', fundedAiEnabled: false, speechEnabled: false, activateSpeech: speech, fetchImpl });
    expect(await disabled({})).toMatchObject({ activated: 0, failed: 0 });
    expect(speech).toHaveBeenCalledTimes(1);
  });
});
