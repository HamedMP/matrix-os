import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { DEFAULT_COMPUTE_CAP_CONFIG, readComputeUsage } from '../../packages/platform/src/free-tier/compute-meter.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider, ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import type { ContainerRuntimeClient } from '../../packages/platform/src/substrates/container-runtime-client.js';
import { createActivityTracker, createIdleReaper } from '../../packages/platform/src/substrates/idle-reaper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CAP = DEFAULT_COMPUTE_CAP_CONFIG.capMs;
const OWNER = 'user_reaped';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ENDPOINT = 'mvm-1.lambda-microvm.eu-west-1.on.aws';

function fakeProvider(): ContainerProvider {
  const unit: ContainerUnit = { unitId: 'mvm-1', state: 'pending', endpointHost: ENDPOINT, createdAt: T0, expiresAt: new Date(T0.getTime() + 8 * HOUR) };
  return {
    run: vi.fn(async () => unit),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({ headers: {}, expiresAt: T0 })),
  };
}

describe('stopping running units at the compute cap', () => {
  let db: PlatformDB;
  let clock: Date;
  let calls: string[];
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(T0);
    calls = [];
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'reaped', status: 'stopped',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container', generation: 1,
    });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function setup(onFlush?: () => void) {
    const now = () => new Date(clock);
    const provider = fakeProvider();
    const lifecycle = createContainerLifecycleService({
      db, provider, now, logError: () => undefined, buildBootPayload: async () => '{}', computeCap: DEFAULT_COMPUTE_CAP_CONFIG,
    });
    const runtime: ContainerRuntimeClient = {
      quiesce: vi.fn(async () => { calls.push('quiesce'); return { ok: true as const, unsettledRuns: 0 }; }),
      resume: vi.fn(async () => { calls.push('resume'); return true; }),
      flush: vi.fn(async () => { calls.push('flush'); onFlush?.(); return { ok: true as const, manifestDigest: DIGEST }; }),
    };
    const activity = createActivityTracker({ db, now, logError: () => undefined });
    const reaper = createIdleReaper({
      db, lifecycle, runtime, activity, now, logError: () => undefined,
      config: { computeCap: DEFAULT_COMPUTE_CAP_CONFIG },
      sleep: async (ms, signal) => { signal.throwIfAborted(); advance(ms); },
    });
    return { lifecycle, activity, reaper, provider };
  }

  async function wake(lifecycle: ReturnType<typeof setup>['lifecycle'], options?: { exportIntent?: boolean }) {
    await lifecycle.ensureStarted('ctr-1', options);
    await lifecycle.drain();
    await lifecycle.markRegistered('ctr-1', (await getUserMachine(db, 'ctr-1'))!.generation);
  }

  it('stops an active unit that crosses the cap at the next sweep, through quiesce, flush and suspend', async () => {
    await db.executor.insertInto('runtime_compute_usage')
      .values({ clerk_user_id: OWNER, month_start: '2026-11-01', billed_ms: CAP - HOUR, export_ms: 0, export_wakes: 0 }).execute();
    const { lifecycle, activity, reaper, provider } = setup(() => activity.observe('ctr-1'));
    await wake(lifecycle);
    advance(30 * MINUTE);
    activity.observe('ctr-1');
    await reaper.sweep();
    await reaper.drain();
    expect(calls).toEqual([]);

    advance(30 * MINUTE);
    activity.observe('ctr-1');
    await reaper.sweep();
    await reaper.drain();
    expect(calls).toEqual(['quiesce', 'flush']);
    expect(provider.suspend).toHaveBeenCalledTimes(1);
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('stopped');
    expect(await readComputeUsage(db.executor, OWNER, clock)).toMatchObject({ billedMs: CAP });
    expect(await lifecycle.ensureStarted('ctr-1')).toMatchObject({ state: 'limit_reached' });
  });

  it('stops an export-only unit once its window ends, even with the owner active', async () => {
    await db.executor.insertInto('runtime_compute_usage')
      .values({ clerk_user_id: OWNER, month_start: '2026-11-01', billed_ms: CAP, export_ms: 0, export_wakes: 0 }).execute();
    const { lifecycle, activity, reaper } = setup();
    await wake(lifecycle, { exportIntent: true });
    advance(14 * MINUTE);
    activity.observe('ctr-1');
    await reaper.sweep();
    await reaper.drain();
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('running');

    advance(MINUTE);
    activity.observe('ctr-1');
    await reaper.sweep();
    await reaper.drain();
    expect(calls).toEqual(['quiesce', 'flush']);
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('stopped');
    expect(await readComputeUsage(db.executor, OWNER, clock)).toEqual({ billedMs: CAP, exportMs: 15 * MINUTE, exportWakes: 1 });
  });

  it('leaves an active unit under the cap running', async () => {
    const { lifecycle, activity, reaper } = setup();
    await wake(lifecycle);
    advance(2 * HOUR);
    activity.observe('ctr-1');
    await reaper.sweep();
    await reaper.drain();
    expect(calls).toEqual([]);
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('running');
  });
});
