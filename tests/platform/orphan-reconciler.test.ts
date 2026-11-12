import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import {
  ContainerProviderError,
  type ContainerProvider,
  type ContainerUnit,
} from '../../packages/platform/src/substrates/container-provider.js';
import { createOrphanReconciler } from '../../packages/platform/src/substrates/orphan-reconciler.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const T0 = new Date('2026-11-12T11:00:00.000Z');
const MINUTE = 60_000;

function unit(unitId: string, overrides: Partial<ContainerUnit> = {}): ContainerUnit {
  return {
    unitId, state: 'running', endpointHost: `${unitId}.lambda-microvm.eu-west-1.on.aws`,
    createdAt: new Date(T0.getTime() - 60 * MINUTE), expiresAt: null, ...overrides,
  };
}

function fakeProvider(units: () => ContainerUnit[], overrides: Partial<ContainerProvider> = {}): ContainerProvider {
  const unused = async (): Promise<never> => { throw new Error('reconciler must not call this'); };
  return {
    run: vi.fn(unused), suspend: vi.fn(unused), resume: vi.fn(unused), describe: vi.fn(unused), mintEndpointCredential: vi.fn(unused),
    list: vi.fn(async () => units()),
    terminate: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('orphan reconciler', () => {
  let db: PlatformDB;
  let clock: Date;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(T0);
    await insertUserMachine(db, {
      machineId: 'ctr-orphan-1', clerkUserId: 'user_orphan_a', handle: 'orphan-alice', status: 'running',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container', generation: 2,
    });
    await db.executor.updateTable('user_machines').set({ substrate_ref: 'mvm-current' })
      .where('machine_id', '=', 'ctr-orphan-1').execute();
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function reconciler(provider: ContainerProvider, config: Parameters<typeof createOrphanReconciler>[0]['config'] = {}) {
    return createOrphanReconciler({ db, provider, now: () => new Date(clock), logError: () => undefined, log: () => undefined, config });
  }

  it('terminates compute that no current record references and keeps the current unit', async () => {
    const provider = fakeProvider(() => [unit('mvm-current'), unit('mvm-old-generation'), unit('mvm-unknown')]);
    expect(await reconciler(provider).sweep()).toEqual({ terminated: 2 });
    const terminated = vi.mocked(provider.terminate).mock.calls.map(([unitId]) => unitId).sort();
    expect(terminated).toEqual(['mvm-old-generation', 'mvm-unknown']);
    expect(vi.mocked(provider.terminate).mock.calls.every(([, signal]) => signal instanceof AbortSignal)).toBe(true);
  });

  it('only ever terminates compute: owner databases, object prefixes, and runtime records stay', async () => {
    await db.executor.updateTable('user_machines').set({ deleted_at: T0.toISOString() })
      .where('machine_id', '=', 'ctr-orphan-1').execute();
    const before = await db.executor.selectFrom('user_machines').selectAll().execute();
    const provider = fakeProvider(() => [unit('mvm-current')]);
    expect(await reconciler(provider).sweep()).toEqual({ terminated: 1 });
    expect(provider.terminate).toHaveBeenCalledWith('mvm-current', expect.any(AbortSignal));
    for (const name of ['run', 'suspend', 'resume', 'describe', 'mintEndpointCredential'] as const) {
      expect(provider[name]).not.toHaveBeenCalled();
    }
    expect(await db.executor.selectFrom('user_machines').selectAll().execute()).toEqual(before);
  });

  it('leaves a unit created by a start still in flight', async () => {
    await db.executor.updateTable('user_machines').set({ status: 'stopped', substrate_ref: null })
      .where('machine_id', '=', 'ctr-orphan-1').execute();
    let listed: ContainerUnit[] = [];
    let sweepResult: { terminated: number } | undefined;
    const provider = fakeProvider(() => listed, {
      run: vi.fn(async () => {
        const created = unit('mvm-starting', { state: 'pending', createdAt: new Date(clock) });
        listed = [created];
        // The reconciler sweeps after the provider created the unit and before the start records it.
        sweepResult = await reconciler(provider).sweep();
        return created;
      }),
    });
    const lifecycle = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, buildBootPayload: async () => '{}',
    });
    await lifecycle.ensureStarted('ctr-orphan-1');
    await lifecycle.drain();
    expect(sweepResult).toEqual({ terminated: 0 });
    expect(provider.terminate).not.toHaveBeenCalled();
    expect(await getUserMachine(db, 'ctr-orphan-1')).toMatchObject({ status: 'starting', substrateRef: 'mvm-starting' });
  });

  it('waits out the grace period for a unit whose creation time is unknown', async () => {
    const provider = fakeProvider(() => [unit('mvm-ageless', { createdAt: null })]);
    const r = reconciler(provider, { graceMs: 10 * MINUTE });
    expect(await r.sweep()).toEqual({ terminated: 0 });
    clock = new Date(T0.getTime() + 5 * MINUTE);
    expect(await r.sweep()).toEqual({ terminated: 0 });
    clock = new Date(T0.getTime() + 11 * MINUTE);
    expect(await r.sweep()).toEqual({ terminated: 1 });
  });

  it('is bounded per sweep and skips units that are already ending', async () => {
    const provider = fakeProvider(() => [
      unit('mvm-gone', { state: 'terminated' }), unit('mvm-going', { state: 'terminating' }),
      ...Array.from({ length: 5 }, (_, index) => unit(`mvm-orphan-${index}`)),
    ]);
    expect(await reconciler(provider, { maxTerminationsPerSweep: 2 }).sweep()).toEqual({ terminated: 2 });
    const terminated = vi.mocked(provider.terminate).mock.calls.map(([unitId]) => unitId);
    expect(terminated).not.toContain('mvm-gone');
    expect(terminated).not.toContain('mvm-going');
  });

  it('keeps going past a failed termination and survives a failed listing', async () => {
    const provider = fakeProvider(() => [unit('mvm-a'), unit('mvm-b')], {
      terminate: vi.fn(async (unitId: string) => { if (unitId === 'mvm-a') throw new ContainerProviderError('throttled'); }),
    });
    expect(await reconciler(provider).sweep()).toEqual({ terminated: 1 });
    const failing = fakeProvider(() => { throw new ContainerProviderError('unavailable'); });
    expect(await reconciler(failing).sweep()).toEqual({ terminated: 0 });
  });

  it('runs on a timer that shutdown clears', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const r = reconciler(fakeProvider(() => []));
      r.start();
      r.start();
      expect(vi.getTimerCount()).toBe(1);
      await r.shutdown();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
