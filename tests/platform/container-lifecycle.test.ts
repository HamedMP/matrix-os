import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  createContainerLifecycleService,
  type ContainerBootContext,
} from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import {
  ContainerProviderError,
  type ContainerProvider,
  type ContainerUnit,
} from '../../packages/platform/src/substrates/container-provider.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { countRunningContainers } from '../../packages/platform/src/free-tier/capacity.js';

const T0 = new Date('2026-11-10T12:00:00.000Z');
const ENDPOINT = 'mvm-new.lambda-microvm.eu-west-1.on.aws';

function unit(overrides: Partial<ContainerUnit> = {}): ContainerUnit {
  return {
    unitId: 'mvm-new',
    state: 'pending',
    endpointHost: ENDPOINT,
    createdAt: T0,
    expiresAt: new Date(T0.getTime() + 8 * 3_600_000),
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<ContainerProvider> = {}): ContainerProvider {
  return {
    run: vi.fn(async () => unit()),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({ headers: {}, expiresAt: T0 })),
    ...overrides,
  };
}

describe('container lifecycle service', () => {
  let db: PlatformDB;
  let clock: Date;
  let boots: ContainerBootContext[];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(T0);
    boots = [];
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: 'user_a', handle: 'alice', status: 'stopped',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container', generation: 1,
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function service(provider: ContainerProvider) {
    return createContainerLifecycleService({
      db,
      provider,
      now: () => new Date(clock),
      logError: () => undefined,
      async buildBootPayload(context) {
        boots.push(context);
        return JSON.stringify({ generation: context.generation });
      },
    });
  }

  const row = async () => (await getUserMachine(db, 'ctr-1'))!;

  it('twenty concurrent starts across two platform instances create one unit', async () => {
    const provider = fakeProvider();
    const a = service(provider);
    const b = service(provider);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).ensureStarted('ctr-1')));
    await Promise.all([a.drain(), b.drain()]);

    expect(results.every(r => r.state === 'starting')).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
    const machine = await row();
    expect(machine).toMatchObject({
      status: 'starting', generation: 2, runtimeTokenEpoch: 2, substrateRef: 'mvm-new', privateAddress: ENDPOINT,
    });
    expect(boots).toEqual([expect.objectContaining({ machineId: 'ctr-1', generation: 2, runtimeTokenEpoch: 2 })]);
    expect(vi.mocked(provider.run).mock.calls[0]?.[0].bootPayload).toBe('{"generation":2}');
  });

  it('bumps generation and token epoch together when compute is replaced', async () => {
    await updateUserMachine(db, 'ctr-1', { runtimeTokenEpoch: 4 });
    const s = service(fakeProvider());
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(await row()).toMatchObject({ generation: 2, runtimeTokenEpoch: 5 });
  });

  it('uses a stable idempotency key per generation so a retried run cannot create a second unit', async () => {
    const provider = fakeProvider();
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    const key = vi.mocked(provider.run).mock.calls[0]?.[0].idempotencyKey;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain('ctr-1');
  });

  it('resumes its own suspended unit instead of replacing it', async () => {
    await updateUserMachine(db, 'ctr-1', { substrateRef: 'mvm-old', privateAddress: 'mvm-old.lambda-microvm.eu-west-1.on.aws' });
    const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'suspended' })) });
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.resume).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
    expect(provider.run).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'running', generation: 1, substrateRef: 'mvm-old' });
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'running' });
  });

  it('runs fresh when the suspended unit is near its 8 hour limit, and terminates the old one', async () => {
    await updateUserMachine(db, 'ctr-1', { substrateRef: 'mvm-old' });
    clock = new Date(T0.getTime() + 7 * 3_600_000 + 50 * 60_000);
    const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'suspended' })) });
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.resume).not.toHaveBeenCalled();
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(provider.terminate).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
    expect(await row()).toMatchObject({ status: 'starting', generation: 2, substrateRef: 'mvm-new' });
  });

  it('replaces a suspended unit whose remaining lifetime cannot hold a full session and its stop', async () => {
    await updateUserMachine(db, 'ctr-1', { substrateRef: 'mvm-old' });
    const sessionAndStop = 4 * 3_600_000 + 22 * 60_000;
    const lifecycle = (provider: ContainerProvider) => createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, minResumeLifetimeMs: sessionAndStop,
      buildBootPayload: async () => '{}',
    });
    // Seven hours in: one hour left, far less than a session and its stop.
    clock = new Date(T0.getTime() + 7 * 3_600_000);
    const short = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'suspended' })) });
    const s = lifecycle(short);
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(short.resume).not.toHaveBeenCalled();
    expect(short.run).toHaveBeenCalledTimes(1);
  });

  it('still resumes a suspended unit with room for a full session and its stop', async () => {
    await updateUserMachine(db, 'ctr-1', { substrateRef: 'mvm-old' });
    clock = new Date(T0.getTime() + 3_600_000);
    const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'suspended' })) });
    const s = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, minResumeLifetimeMs: 4 * 3_600_000 + 22 * 60_000,
      buildBootPayload: async () => '{}',
    });
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.resume).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
  });

  it('reopens the gateway of a resumed unit before marking it running, and keeps the unit when it does not reopen', async () => {
    await updateUserMachine(db, 'ctr-1', { substrateRef: 'mvm-old', privateAddress: 'mvm-old.lambda-microvm.eu-west-1.on.aws' });
    const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'suspended' })) });
    const reviveInPlace = vi.fn(async () => false);
    const s = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, reviveInPlace, buildBootPayload: async () => '{}',
    });
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.resume).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
    expect(reviveInPlace).toHaveBeenCalledWith(expect.objectContaining({ unitId: 'mvm-old' }), expect.any(AbortSignal));
    expect(provider.run).not.toHaveBeenCalled();
    expect(provider.terminate).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'needs_recovery', substrateRef: 'mvm-old' });

    reviveInPlace.mockResolvedValue(true);
    vi.mocked(provider.describe).mockResolvedValue(unit({ unitId: 'mvm-old', state: 'running' }));
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(await row()).toMatchObject({ status: 'running', substrateRef: 'mvm-old' });
  });

  it('resumes a failed stop\'s surviving unit to flush it, ending its session before the unit expires', async () => {
    await updateUserMachine(db, 'ctr-1', { status: 'needs_recovery', substrateRef: 'mvm-old', privateAddress: 'mvm-old.lambda-microvm.eu-west-1.on.aws' });
    const sessionAndStop = 4 * 3_600_000 + 22 * 60_000;
    // Five hours in: three hours left, less than a whole session and its stop.
    clock = new Date(T0.getTime() + 5 * 3_600_000);
    const expiresAt = new Date(T0.getTime() + 8 * 3_600_000);
    const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'suspended', expiresAt })) });
    const s = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, minResumeLifetimeMs: sessionAndStop,
      reviveInPlace: async () => true, buildBootPayload: async () => '{}',
    });
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.resume).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
    expect(provider.run).not.toHaveBeenCalled();
    expect(provider.terminate).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({
      status: 'running', substrateRef: 'mvm-old', startedAt: new Date(expiresAt.getTime() - sessionAndStop).toISOString(),
    });
  });

  it('ends a revived running unit\'s session before the unit expires', async () => {
    await updateUserMachine(db, 'ctr-1', { status: 'needs_recovery', substrateRef: 'mvm-old', privateAddress: 'mvm-old.lambda-microvm.eu-west-1.on.aws' });
    const sessionAndStop = 4 * 3_600_000 + 22 * 60_000;
    clock = new Date(T0.getTime() + 7 * 3_600_000);
    const expiresAt = new Date(T0.getTime() + 8 * 3_600_000);
    const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'running', expiresAt })) });
    const s = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, minResumeLifetimeMs: sessionAndStop,
      reviveInPlace: async () => true, buildBootPayload: async () => '{}',
    });
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.run).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({
      status: 'running', substrateRef: 'mvm-old', startedAt: new Date(expiresAt.getTime() - sessionAndStop).toISOString(),
    });
  });

  it('treats a unit the provider no longer knows as run fresh, not as a failure', async () => {
    await updateUserMachine(db, 'ctr-1', { substrateRef: 'mvm-expired' });
    const provider = fakeProvider();
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ status: 'starting', generation: 2, failureCode: null });
  });

  it('accepts registration for the current generation only, idempotently', async () => {
    const s = service(fakeProvider());
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(await s.markRegistered('ctr-1', 1)).toBe('stale_generation');
    expect((await row()).status).toBe('starting');
    expect(await s.markRegistered('ctr-1', 2)).toBe('ok');
    expect(await s.markRegistered('ctr-1', 2)).toBe('ok');
    expect(await row()).toMatchObject({ status: 'running', generation: 2 });
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'running' });
  });

  it('asks a runtime that registers before its unit is recorded to retry, and keeps the unit', async () => {
    let s!: ReturnType<typeof service>;
    const outcomes: string[] = [];
    const provider = fakeProvider({
      run: vi.fn(async () => {
        // The new gateway is fast: it registers before `run` has returned to the platform.
        outcomes.push(await s.markRegistered('ctr-1', 2));
        return unit();
      }),
    });
    s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();

    expect(outcomes).toEqual(['unit_pending']);
    expect(provider.terminate).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'starting', generation: 2, substrateRef: 'mvm-new' });
    expect(await s.markRegistered('ctr-1', 2)).toBe('ok');
    expect(await row()).toMatchObject({ status: 'running', substrateRef: 'mvm-new', privateAddress: ENDPOINT });
  });

  it('terminates a new unit whose generation was fenced while it was being created', async () => {
    const provider = fakeProvider({
      run: vi.fn(async () => {
        await updateUserMachine(db, 'ctr-1', { status: 'failed_start' });
        return unit();
      }),
    });
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(provider.terminate).toHaveBeenCalledWith('mvm-new', expect.any(AbortSignal));
    expect((await row()).substrateRef).toBeNull();
  });

  it('records a typed failure, reports it during the cooldown, and retries after it', async () => {
    const provider = fakeProvider({ run: vi.fn(async () => unit()).mockRejectedValueOnce(new ContainerProviderError('unavailable')) });
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(await row()).toMatchObject({ status: 'failed_start', failureCode: 'provider_unavailable' });
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'provider_unavailable' });
    expect(provider.run).toHaveBeenCalledTimes(1);

    clock = new Date(clock.getTime() + 31_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
    await s.drain();
    expect(provider.run).toHaveBeenCalledTimes(2);
    expect(await row()).toMatchObject({ status: 'starting', failureCode: null });
  });

  it.each([
    ['failed_start', 'running'],
    ['failed_start', 'pending'],
    ['stopped', 'running'],
  ] as const)('behind a %s row, replaces a provider-%s unit instead of trusting it', async (status, unitState) => {
    await updateUserMachine(db, 'ctr-1', {
      status, substrateRef: 'mvm-old', failureCode: status === 'failed_start' ? 'start_timeout' : null,
      failureAt: status === 'failed_start' ? '2026-11-10T11:00:00.000Z' : null,
    });
    const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: unitState })) });
    const s = service(provider);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
    await s.drain();
    expect(provider.resume).not.toHaveBeenCalled();
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(provider.terminate).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
    expect(await row()).toMatchObject({ status: 'starting', generation: 2, substrateRef: 'mvm-new' });
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
  });

  it('moves a stop that never finished to needs_recovery after the quiesce bound', async () => {
    await updateUserMachine(db, 'ctr-1', { status: 'running', substrateRef: 'mvm-old' });
    const stuck = new AbortController();
    const provider = fakeProvider({
      suspend: vi.fn((_id: string, signal: AbortSignal) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new ContainerProviderError('timeout')));
      })),
    });
    const s = service(provider);
    const stopping = s.stop('ctr-1', 1, stuck.signal);
    await vi.waitFor(() => expect(provider.suspend).toHaveBeenCalledTimes(1));
    expect((await row()).status).toBe('quiescing');

    clock = new Date(T0.getTime() + 20 * 60_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
    clock = new Date(T0.getTime() + 23 * 60_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'needs_recovery' });
    expect(await row()).toMatchObject({ status: 'needs_recovery', failureCode: 'quiesce_timeout' });

    stuck.abort();
    expect(await stopping).toBe('needs_recovery');
    expect((await row()).failureCode).toBe('quiesce_timeout');
  });

  it('reports provider capacity as busy', async () => {
    const s = service(fakeProvider({ run: vi.fn(async () => { throw new ContainerProviderError('capacity'); }) }));
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'busy' });
  });

  it('fails a start that has not registered within 90 seconds', async () => {
    const s = service(fakeProvider());
    await s.ensureStarted('ctr-1');
    await s.drain();
    clock = new Date(clock.getTime() + 89_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
    clock = new Date(clock.getTime() + 2_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'start_timeout' });
    expect(await row()).toMatchObject({ status: 'failed_start', failureCode: 'start_timeout' });
    expect(await s.markRegistered('ctr-1', 2)).toBe('not_starting');
  });

  const unconfirmed = async () => (await db.executor.selectFrom('user_machines').select('compute_unconfirmed_until')
    .where('machine_id', '=', 'ctr-1').executeTakeFirstOrThrow()).compute_unconfirmed_until;

  /** A provider whose units stay described until a terminate takes effect, or only start terminating. */
  function statefulProvider(options: { terminate?: 'gone' | 'terminating' | 'fails'; old?: ContainerUnit } = {}) {
    const units = new Map<string, ContainerUnit>(options.old ? [[options.old.unitId, options.old]] : []);
    return fakeProvider({
      run: vi.fn(async () => { const created = unit({ createdAt: new Date(clock) }); units.set(created.unitId, created); return created; }),
      describe: vi.fn(async (unitId: string) => units.get(unitId) ?? null),
      terminate: vi.fn(async (unitId: string) => {
        if (options.terminate === 'fails') throw new ContainerProviderError('unavailable');
        const existing = units.get(unitId);
        if (!existing) return;
        if (options.terminate === 'terminating') units.set(unitId, { ...existing, state: 'terminating' });
        else units.delete(unitId);
      }),
    });
  }

  it('ends the unit of a start that never registered, so the failed start frees its slot once that is confirmed', async () => {
    const provider = statefulProvider();
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    clock = new Date(clock.getTime() + 91_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'start_timeout' });
    expect(provider.terminate).toHaveBeenCalledWith('mvm-new', expect.any(AbortSignal));
    expect(await unconfirmed()).toBeNull();
    expect(await countRunningContainers(db.executor, clock)).toBe(0);
  });

  it('keeps the slot of a start that never registered while its unit is only terminating', async () => {
    const s = service(statefulProvider({ terminate: 'terminating' }));
    await s.ensureStarted('ctr-1');
    await s.drain();
    clock = new Date(clock.getTime() + 91_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'start_timeout' });
    expect(await countRunningContainers(db.executor, clock)).toBe(1);
  });

  it('keeps the slot of a start that never registered while its unit cannot be confirmed ended', async () => {
    const provider = statefulProvider({ terminate: 'fails' });
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    clock = new Date(clock.getTime() + 91_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'start_timeout' });
    expect(await row()).toMatchObject({ status: 'failed_start' });
    expect((await unconfirmed())?.getTime()).toBeGreaterThanOrEqual(T0.getTime() + 8 * 3_600_000);
    expect(await countRunningContainers(db.executor, clock)).toBe(1);
  });

  it('never terminates the old unit a recovery start had kept when that start times out', async () => {
    // The platform stopped after claiming a recovery start, before replacing or resuming the unit.
    const old = unit({ unitId: 'mvm-old', state: 'running', createdAt: new Date(T0.getTime() - 3_600_000) });
    const provider = statefulProvider({ old });
    await updateUserMachine(db, 'ctr-1', { status: 'starting', substrateRef: 'mvm-old',
      privateAddress: 'mvm-old.lambda-microvm.eu-west-1.on.aws' });
    await db.executor.updateTable('user_machines').set({ started_at: T0 }).where('machine_id', '=', 'ctr-1').execute();
    const s = service(provider);
    clock = new Date(clock.getTime() + 91_000);
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'start_timeout' });
    expect(provider.terminate).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'failed_start', substrateRef: 'mvm-old' });
    // The kept unit may still run, so it keeps its slot.
    expect(await countRunningContainers(db.executor, clock)).toBe(1);
  });

  it('keeps the slot of a unit created without an endpoint while its termination is unconfirmed', async () => {
    const provider = fakeProvider({
      run: vi.fn(async () => unit({ endpointHost: null })),
      terminate: vi.fn(async () => { throw new ContainerProviderError('unavailable'); }),
    });
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(await row()).toMatchObject({ status: 'failed_start' });
    expect(await countRunningContainers(db.executor, clock)).toBe(1);
  });

  it('suspends a running unit on stop and rejects a stale generation', async () => {
    await updateUserMachine(db, 'ctr-1', { status: 'running', generation: 3, substrateRef: 'mvm-old' });
    const provider = fakeProvider();
    const s = service(provider);
    expect(await s.stop('ctr-1', 2, AbortSignal.timeout(10_000))).toBe('stale_generation');
    expect(provider.suspend).not.toHaveBeenCalled();
    expect(await s.stop('ctr-1', 3, AbortSignal.timeout(10_000))).toBe('stopped');
    expect(provider.suspend).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
    expect(await row()).toMatchObject({ status: 'stopped', generation: 3, substrateRef: 'mvm-old' });
    expect(await s.stop('ctr-1', 3, AbortSignal.timeout(10_000))).toBe('stopped');
  });

  it('moves to needs_recovery when the unit cannot be suspended', async () => {
    await updateUserMachine(db, 'ctr-1', { status: 'running', substrateRef: 'mvm-old' });
    const s = service(fakeProvider({ suspend: vi.fn(async () => { throw new ContainerProviderError('unavailable'); }) }));
    expect(await s.stop('ctr-1', 1, AbortSignal.timeout(10_000))).toBe('needs_recovery');
    expect(await row()).toMatchObject({ status: 'needs_recovery', failureCode: 'provider_unavailable' });
  });

  describe('starting from needs_recovery', () => {
    const DIGEST = `sha256:${'d'.repeat(64)}`;
    const OLD_ENDPOINT = 'mvm-old.lambda-microvm.eu-west-1.on.aws';

    beforeEach(async () => {
      await updateUserMachine(db, 'ctr-1', { status: 'needs_recovery', substrateRef: 'mvm-old', privateAddress: OLD_ENDPOINT });
      await db.executor.updateTable('user_machines').set({
        failure_code: 'flush_failed', last_flush_digest: DIGEST, last_flushed_at: new Date(T0.getTime() - 60_000),
      }).where('machine_id', '=', 'ctr-1').execute();
    });

    it('resumes the surviving suspended unit, so its unflushed disk is kept', async () => {
      const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'suspended' })) });
      const s = service(provider);
      expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
      await s.drain();
      expect(provider.resume).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
      expect(provider.run).not.toHaveBeenCalled();
      expect(await row()).toMatchObject({ status: 'running', generation: 1, substrateRef: 'mvm-old', failureCode: null });
    });

    it('reopens a unit that is still running instead of replacing it', async () => {
      const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'running' })) });
      const reviveInPlace = vi.fn(async () => true);
      const s = createContainerLifecycleService({
        db, provider, now: () => new Date(clock), logError: () => undefined, reviveInPlace, buildBootPayload: async () => '{}',
      });
      await s.ensureStarted('ctr-1');
      await s.drain();
      expect(reviveInPlace).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'ctr-1', unitId: 'mvm-old', endpointHost: OLD_ENDPOINT, clerkUserId: 'user_a', handle: 'alice',
      }), expect.any(AbortSignal));
      expect(provider.run).not.toHaveBeenCalled();
      expect(provider.terminate).not.toHaveBeenCalled();
      expect(await row()).toMatchObject({ status: 'running', generation: 1, substrateRef: 'mvm-old' });
    });

    it('runs fresh with the last good flush when no unit survives, so the runtime reports the lost interval', async () => {
      const provider = fakeProvider();
      const s = service(provider);
      await s.ensureStarted('ctr-1');
      await s.drain();
      expect(provider.run).toHaveBeenCalledTimes(1);
      expect(boots).toEqual([expect.objectContaining({
        generation: 2,
        recovery: { lastFlushDigest: DIGEST, lastFlushedAt: new Date(T0.getTime() - 60_000).toISOString() },
      })]);
      expect(await row()).toMatchObject({ status: 'starting', generation: 2, substrateRef: 'mvm-new' });
    });

    it('replaces a running unit whose gateway does not answer, still booting with recovery data', async () => {
      const provider = fakeProvider({ describe: vi.fn(async () => unit({ unitId: 'mvm-old', state: 'running' })) });
      const s = createContainerLifecycleService({
        db, provider, now: () => new Date(clock), logError: () => undefined, reviveInPlace: async () => false,
        async buildBootPayload(context) { boots.push(context); return '{}'; },
      });
      await s.ensureStarted('ctr-1');
      await s.drain();
      expect(provider.run).toHaveBeenCalledTimes(1);
      expect(provider.terminate).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
      expect(boots[0]?.recovery?.lastFlushDigest).toBe(DIGEST);
    });
  });

  it('boots an ordinary start without recovery data', async () => {
    const s = service(fakeProvider());
    await s.ensureStarted('ctr-1');
    await s.drain();
    expect(boots[0]).not.toHaveProperty('recovery');
  });

  it('destroys compute for the current generation and leaves the runtime startable', async () => {
    await updateUserMachine(db, 'ctr-1', { status: 'running', substrateRef: 'mvm-old', privateAddress: ENDPOINT });
    const provider = fakeProvider();
    const s = service(provider);
    expect(await s.destroyCompute('ctr-1', 0, AbortSignal.timeout(10_000))).toBe('stale_generation');
    expect(await s.destroyCompute('ctr-1', 1, AbortSignal.timeout(10_000))).toBe('destroyed');
    expect(provider.terminate).toHaveBeenCalledWith('mvm-old', expect.any(AbortSignal));
    expect(await row()).toMatchObject({ status: 'stopped', substrateRef: null, privateAddress: null, generation: 1 });
  });

  it('ignores machines that are not container runtimes', async () => {
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: 'user_b', handle: 'bob', status: 'stopped',
      provisionedAt: '2026-11-01T00:00:00.000Z',
    });
    const provider = fakeProvider();
    const s = service(provider);
    expect(await s.ensureStarted('vps-1')).toEqual({ state: 'failed', code: 'needs_recovery' });
    expect(await s.ensureStarted('missing')).toEqual({ state: 'failed', code: 'needs_recovery' });
    expect(provider.run).not.toHaveBeenCalled();
  });

  it('caps concurrent launches per process and reports busy beyond the cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = fakeProvider({ run: vi.fn(async () => { await gate; return unit(); }) });
    const s = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, maxConcurrentLaunches: 1,
      buildBootPayload: async () => '{}',
    });
    await insertUserMachine(db, {
      machineId: 'ctr-2', clerkUserId: 'user_c', handle: 'carol', status: 'stopped',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container',
    });
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'starting' });
    await vi.waitFor(() => expect(provider.run).toHaveBeenCalledTimes(1));
    expect(await s.ensureStarted('ctr-2')).toEqual({ state: 'busy' });
    expect((await getUserMachine(db, 'ctr-2'))?.status).toBe('stopped');
    release();
    await s.drain();
  });

  it('holds the launch cap for a burst of starts that all pass the check before any claim lands', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = fakeProvider({ run: vi.fn(async () => { await gate; return unit(); }) });
    const s = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, maxConcurrentLaunches: 2,
      buildBootPayload: async () => '{}',
    });
    const ids = ['ctr-2', 'ctr-3', 'ctr-4', 'ctr-5'];
    for (const [i, machineId] of ids.entries()) {
      await insertUserMachine(db, {
        machineId, clerkUserId: `user_burst_${i}`, handle: `burst${i}`, status: 'stopped',
        provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container',
      });
    }
    const results = await Promise.all(['ctr-1', ...ids].map(id => s.ensureStarted(id)));
    release();
    await s.drain();
    expect(results.filter(r => r.state === 'starting')).toHaveLength(2);
    expect(results.filter(r => r.state === 'busy')).toHaveLength(3);
    expect(provider.run).toHaveBeenCalledTimes(2);
  });

  it('aborts in-flight provider calls on shutdown', async () => {
    const provider = fakeProvider({
      run: vi.fn((_input, signal: AbortSignal) => new Promise<ContainerUnit>((_, reject) => {
        signal.addEventListener('abort', () => reject(new ContainerProviderError('timeout')));
      })),
    });
    const s = service(provider);
    await s.ensureStarted('ctr-1');
    await vi.waitFor(() => expect(provider.run).toHaveBeenCalledTimes(1));
    await s.shutdown();
    expect(await row()).toMatchObject({ status: 'failed_start', failureCode: 'provider_unavailable' });
  });
});
