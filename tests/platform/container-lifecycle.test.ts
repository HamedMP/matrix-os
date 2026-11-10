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
    expect(await s.ensureStarted('ctr-1')).toEqual({ state: 'failed', code: 'needs_recovery' });
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
