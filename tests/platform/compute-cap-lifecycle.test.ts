import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { DEFAULT_COMPUTE_CAP_CONFIG, readComputeUsage } from '../../packages/platform/src/free-tier/compute-meter.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider, ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const HOUR = 3_600_000;
const CAP = DEFAULT_COMPUTE_CAP_CONFIG.capMs;
const OWNER = 'user_cap';
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

describe('monthly compute metering and cap', () => {
  let db: PlatformDB;
  let clock: Date;
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(T0);
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'capped', status: 'stopped',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container', generation: 1,
    });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function service(provider = fakeProvider()) {
    return createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined,
      buildBootPayload: async () => '{}', computeCap: DEFAULT_COMPUTE_CAP_CONFIG,
    });
  }

  async function seedBilled(billedMs: number, extra: { exportWakes?: number; month?: string } = {}) {
    await db.executor.insertInto('runtime_compute_usage').values({
      clerk_user_id: OWNER, month_start: extra.month ?? '2026-11-01', billed_ms: billedMs, export_ms: 0, export_wakes: extra.exportWakes ?? 0,
    }).execute();
  }

  async function startAndRegister(lifecycle: ReturnType<typeof service>, options?: { exportIntent?: boolean }) {
    const result = await lifecycle.ensureStarted('ctr-1', options);
    await lifecycle.drain();
    const row = (await getUserMachine(db, 'ctr-1'))!;
    await lifecycle.markRegistered('ctr-1', row.generation);
    return { result, generation: row.generation };
  }

  const usage = (at = clock) => readComputeUsage(db.executor, OWNER, at);

  it('bills from the start to the suspend, idle tail included, and counts a running unit at read time', async () => {
    const lifecycle = service();
    const { generation } = await startAndRegister(lifecycle);
    advance(2 * HOUR);
    expect(await usage()).toMatchObject({ billedMs: 2 * HOUR });
    advance(10 * 60_000);
    expect(await lifecycle.stop('ctr-1', generation, AbortSignal.timeout(1_000))).toBe('stopped');
    advance(5 * HOUR);
    expect(await usage()).toEqual({ billedMs: 2 * HOUR + 10 * 60_000, exportMs: 0, exportWakes: 0 });
  });

  it('closes an interval exactly once when stops, compute loss, and destroy race', async () => {
    const lifecycle = service();
    const { generation } = await startAndRegister(lifecycle);
    advance(HOUR);
    const other = service();
    await Promise.all([
      lifecycle.stop('ctr-1', generation, AbortSignal.timeout(1_000)),
      other.stop('ctr-1', generation, AbortSignal.timeout(1_000)),
      other.markComputeLost('ctr-1', generation, 'mvm-1'),
      lifecycle.destroyCompute('ctr-1', generation, AbortSignal.timeout(1_000)),
      other.destroyCompute('ctr-1', generation, AbortSignal.timeout(1_000)),
    ]);
    advance(HOUR);
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('stopped');
    expect(await usage()).toMatchObject({ billedMs: HOUR });
  });

  it('keeps counting an interval left open by a platform crash and closes it once afterwards', async () => {
    const crashed = service();
    const { generation } = await startAndRegister(crashed);
    advance(3 * HOUR);
    const restarted = service();
    expect(await usage()).toMatchObject({ billedMs: 3 * HOUR });
    expect(await restarted.beginQuiesce('ctr-1', generation)).toBe(true);
    advance(60_000);
    expect(await restarted.finishStop('ctr-1', generation, AbortSignal.timeout(1_000))).toBe('stopped');
    expect(await restarted.finishStop('ctr-1', generation, AbortSignal.timeout(1_000))).toBe('stopped');
    advance(HOUR);
    expect(await usage()).toMatchObject({ billedMs: 3 * HOUR + 60_000 });
  });

  it('bills a failed start up to its failure', async () => {
    const provider = fakeProvider();
    vi.mocked(provider.run).mockImplementationOnce(async () => { advance(60_000); throw new Error('boom'); });
    const lifecycle = service(provider);
    await lifecycle.ensureStarted('ctr-1');
    await lifecycle.drain();
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('failed_start');
    advance(HOUR);
    expect(await usage()).toMatchObject({ billedMs: 60_000 });
  });

  it('starts just under the cap and refuses at exactly the cap until the next UTC month', async () => {
    await seedBilled(CAP - 1);
    const lifecycle = service();
    const { result, generation } = await startAndRegister(lifecycle);
    expect(result).toEqual({ state: 'starting' });
    advance(1);
    expect(await lifecycle.stop('ctr-1', generation, AbortSignal.timeout(1_000))).toBe('stopped');
    expect(await usage()).toMatchObject({ billedMs: CAP });
    expect(await lifecycle.ensureStarted('ctr-1')).toEqual({ state: 'limit_reached', limit: 'compute', resetsAt: '2026-12-01T00:00:00.000Z' });
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('stopped');

    clock = new Date('2026-12-01T00:00:00.000Z');
    expect(await lifecycle.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
    await lifecycle.drain();
  });

  it('splits a session that runs over midnight at the month end', async () => {
    await seedBilled(CAP - HOUR);
    clock = new Date('2026-11-30T23:30:00.000Z');
    const lifecycle = service();
    const { generation } = await startAndRegister(lifecycle);
    clock = new Date('2026-12-01T00:45:00.000Z');
    expect(await lifecycle.stop('ctr-1', generation, AbortSignal.timeout(1_000))).toBe('stopped');
    expect(await usage(new Date('2026-11-30T23:59:59.000Z'))).toMatchObject({ billedMs: CAP - HOUR / 2 });
    expect(await usage()).toMatchObject({ billedMs: 45 * 60_000 });
  });

  it('allows two export-only wakes per month at the cap, metered apart from billed time', async () => {
    await seedBilled(CAP);
    const lifecycle = service();
    for (let wake = 1; wake <= 2; wake += 1) {
      const { result, generation } = await startAndRegister(lifecycle, { exportIntent: true });
      expect(result).toEqual({ state: 'starting' });
      expect((await getUserMachine(db, 'ctr-1'))?.computeMode).toBe('export_only');
      advance(15 * 60_000);
      expect(await lifecycle.stop('ctr-1', generation, AbortSignal.timeout(1_000))).toBe('stopped');
    }
    expect(await usage()).toEqual({ billedMs: CAP, exportMs: 30 * 60_000, exportWakes: 2 });
    expect(await lifecycle.ensureStarted('ctr-1', { exportIntent: true }))
      .toEqual({ state: 'limit_reached', limit: 'compute', resetsAt: '2026-12-01T00:00:00.000Z' });
  });

  it('gives an export intent a normal start while under the cap', async () => {
    const lifecycle = service();
    await startAndRegister(lifecycle, { exportIntent: true });
    expect((await getUserMachine(db, 'ctr-1'))?.computeMode).toBe('full');
    expect(await usage()).toMatchObject({ exportWakes: 0 });
  });

  it('lets twenty concurrent export wakes at the cap use one wake', async () => {
    await seedBilled(CAP);
    const lifecycle = service();
    await Promise.all(Array.from({ length: 20 }, () => lifecycle.ensureStarted('ctr-1', { exportIntent: true })));
    await lifecycle.drain();
    expect(await usage()).toMatchObject({ exportWakes: 1 });
  });

  it('leaves a paid VPS machine unmetered and untouched', async () => {
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: 'user_paid', handle: 'paid', status: 'running',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'vps',
    });
    const lifecycle = service();
    expect(await lifecycle.ensureStarted('vps-1')).toEqual({ state: 'failed', code: 'needs_recovery' });
    expect(await readComputeUsage(db.executor, 'user_paid', clock)).toEqual({ billedMs: 0, exportMs: 0, exportWakes: 0 });
    expect(await db.executor.selectFrom('runtime_compute_usage').selectAll().where('clerk_user_id', '=', 'user_paid').execute()).toEqual([]);
  });
});
