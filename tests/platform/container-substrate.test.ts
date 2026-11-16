import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import { ContainerProviderError, type ContainerProvider, type ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import {
  ContainerSubstrateError,
  createContainerSubstrate,
} from '../../packages/platform/src/substrates/container-substrate.js';
import type { RoutableMachine, RuntimeRef } from '../../packages/platform/src/substrates/types.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const T0 = new Date('2026-11-10T12:00:00.000Z');
const HOST = 'mvm-a.lambda-microvm.eu-west-1.on.aws';
const signal = () => AbortSignal.timeout(10_000);

function fakeProvider(overrides: Partial<ContainerProvider> = {}): ContainerProvider {
  let minted = 0;
  return {
    run: vi.fn(async (): Promise<ContainerUnit> => ({
      unitId: 'mvm-a', state: 'pending', endpointHost: HOST, createdAt: T0, expiresAt: new Date(T0.getTime() + 8 * 3_600_000),
    })),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => [
      { unitId: 'mvm-a', state: 'running' as const, endpointHost: null, createdAt: T0, expiresAt: null },
      { unitId: 'mvm-b', state: 'suspending' as const, endpointHost: null, createdAt: null, expiresAt: null },
    ]),
    mintEndpointCredential: vi.fn(async () => {
      minted += 1;
      return { headers: { 'X-aws-proxy-auth': `token-${minted}`, 'X-aws-proxy-port': '4000' }, expiresAt: new Date(T0.getTime() + 30 * 60_000) };
    }),
    ...overrides,
  };
}

describe('container substrate', () => {
  let db: PlatformDB;
  let clock: Date;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(T0);
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: 'user_a', handle: 'alice', status: 'running',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container', generation: 2,
      substrateRef: 'mvm-a', privateAddress: HOST,
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function substrate(provider: ContainerProvider, credentialCacheMax?: number) {
    const lifecycle = createContainerLifecycleService({
      db, provider, now: () => new Date(clock), logError: () => undefined, buildBootPayload: async () => '{}',
    });
    return {
      lifecycle,
      substrate: createContainerSubstrate({
        lifecycle, provider, endpointHostSuffix: '.on.aws', now: () => new Date(clock),
        loadMachine: (machineId) => getUserMachine(db, machineId),
        ...(credentialCacheMax ? { credentialCacheMax } : {}),
      }),
    };
  }

  const ref = (generation = 2, machineId = 'ctr-1'): RuntimeRef => ({ machineId, handle: 'alice', runtimeSlot: 'primary', generation });
  const routable = async (): Promise<RoutableMachine> => (await getUserMachine(db, 'ctr-1'))!;

  it('starts on demand', () => {
    expect(substrate(fakeProvider()).substrate).toMatchObject({ kind: 'container', startsOnDemand: true });
  });

  it('is not routable until a running runtime has a platform-minted credential', async () => {
    const { substrate: s } = substrate(fakeProvider());
    expect(s.resolveUpstream(await routable(), { path: '/api/health' })).toBeNull();
    expect(await s.ensureRunning(ref(), signal())).toEqual({ state: 'running' });
    expect(s.resolveUpstream(await routable(), { path: '/api/health', queryString: '?a=1' })).toEqual({
      url: `https://${HOST}/api/health?a=1`,
      hostHeader: HOST,
      tlsServerName: HOST,
      headers: { 'X-aws-proxy-auth': 'token-1', 'X-aws-proxy-port': '4000' },
    });
  });

  it('builds upstreams only from platform records and refuses foreign or malformed hosts', async () => {
    const { substrate: s } = substrate(fakeProvider());
    await s.ensureRunning(ref(), signal());
    const machine = await routable();
    for (const privateAddress of ['evil.example.com', `${HOST}/x`, `user@${HOST}`, null]) {
      expect(s.resolveUpstream({ ...machine, privateAddress }, { path: '/' })).toBeNull();
    }
    expect(s.resolveUpstream({ ...machine, status: 'stopped' }, { path: '/' })).toBeNull();
    expect(s.resolveUpstream({ ...machine, substrateRef: 'mvm-other' }, { path: '/' })).toBeNull();
    expect(s.resolveUpstream(machine, { path: 'api' })?.url).toBe(`https://${HOST}/api`);
  });

  it('reuses a credential until it is close to expiry, then mints a new one', async () => {
    const provider = fakeProvider();
    const { substrate: s } = substrate(provider);
    await s.ensureRunning(ref(), signal());
    await s.ensureRunning(ref(), signal());
    expect(provider.mintEndpointCredential).toHaveBeenCalledTimes(1);
    clock = new Date(T0.getTime() + 26 * 60_000);
    await s.ensureRunning(ref(), signal());
    expect(provider.mintEndpointCredential).toHaveBeenCalledTimes(2);
    expect(s.resolveUpstream(await routable(), { path: '/' })?.headers?.['X-aws-proxy-auth']).toBe('token-2');
  });

  it('drops expired credentials from routing even without a refresh', async () => {
    const { substrate: s } = substrate(fakeProvider());
    await s.ensureRunning(ref(), signal());
    clock = new Date(T0.getTime() + 31 * 60_000);
    expect(s.resolveUpstream(await routable(), { path: '/' })).toBeNull();
  });

  it('caps the credential cache', async () => {
    const provider = fakeProvider();
    const { substrate: s } = substrate(provider, 1);
    await insertUserMachine(db, {
      machineId: 'ctr-2', clerkUserId: 'user_b', handle: 'bob', status: 'running',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container', generation: 1,
      substrateRef: 'mvm-b', privateAddress: 'mvm-b.lambda-microvm.eu-west-1.on.aws',
    });
    await s.ensureRunning(ref(), signal());
    await s.ensureRunning(ref(1, 'ctr-2'), signal());
    expect(s.resolveUpstream(await routable(), { path: '/' })).toBeNull();
    expect(s.resolveUpstream((await getUserMachine(db, 'ctr-2'))!, { path: '/' })).not.toBeNull();
  });

  it('reports a credential failure as provider unavailable', async () => {
    const { substrate: s } = substrate(fakeProvider({ mintEndpointCredential: vi.fn(async () => { throw new Error('boom'); }) }));
    expect(await s.ensureRunning(ref(), signal())).toEqual({ state: 'failed', code: 'provider_unavailable' });
  });

  it.each([
    ['gone', new ContainerProviderError('not_found'), null],
    ['terminated', new ContainerProviderError('conflict'), 'terminated'],
  ] as const)('starts fresh when a running unit is %s instead of failing every request', async (_label, error, describedState) => {
    const provider = fakeProvider({
      mintEndpointCredential: vi.fn(async () => { throw error; }),
      describe: vi.fn(async () => describedState
        ? { unitId: 'mvm-a', state: describedState, endpointHost: HOST, createdAt: T0, expiresAt: T0 }
        : null),
    });
    const { substrate: s, lifecycle } = substrate(provider);
    expect(await s.ensureRunning(ref(), signal())).toEqual({ state: 'starting' });
    await lifecycle.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(await getUserMachine(db, 'ctr-1')).toMatchObject({ status: 'starting', generation: 3, substrateRef: 'mvm-a' });
    expect(provider.describe).toHaveBeenCalledTimes(describedState ? 1 : 0);
  });

  it('keeps a live unit when minting fails transiently', async () => {
    const provider = fakeProvider({
      mintEndpointCredential: vi.fn(async () => { throw new ContainerProviderError('throttled'); }),
      describe: vi.fn(async () => ({ unitId: 'mvm-a', state: 'running' as const, endpointHost: HOST, createdAt: T0, expiresAt: null })),
    });
    const { substrate: s } = substrate(provider);
    expect(await s.ensureRunning(ref(), signal())).toEqual({ state: 'failed', code: 'provider_unavailable' });
    expect(provider.describe).not.toHaveBeenCalled();
    expect(await getUserMachine(db, 'ctr-1')).toMatchObject({ status: 'running', generation: 2, substrateRef: 'mvm-a' });
  });

  it('starts a stopped runtime through the lifecycle', async () => {
    await updateUserMachine(db, 'ctr-1', { status: 'stopped', substrateRef: null, privateAddress: null });
    const provider = fakeProvider();
    const { substrate: s, lifecycle } = substrate(provider);
    expect(await s.ensureRunning(ref(), signal())).toEqual({ state: 'starting' });
    await lifecycle.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(provider.mintEndpointCredential).not.toHaveBeenCalled();
  });

  it('stops with generation fencing and forgets the credential', async () => {
    const provider = fakeProvider();
    const { substrate: s } = substrate(provider);
    await s.ensureRunning(ref(), signal());
    await expect(s.stop(ref(1), signal())).rejects.toMatchObject({ code: 'stale_generation' });
    await s.stop(ref(), signal());
    expect(provider.suspend).toHaveBeenCalledWith('mvm-a', expect.any(AbortSignal));
    expect(s.resolveUpstream({ ...(await routable()), status: 'running' }, { path: '/' })).toBeNull();
  });

  it('surfaces a failed suspend as a typed error', async () => {
    const { substrate: s } = substrate(fakeProvider({ suspend: vi.fn(async () => { throw new Error('x'); }) }));
    const error = await s.stop(ref(), signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerSubstrateError);
    expect(error).toMatchObject({ code: 'needs_recovery' });
  });

  it('destroys compute for the current generation only', async () => {
    const provider = fakeProvider();
    const { substrate: s } = substrate(provider);
    await expect(s.destroyCompute(ref(1), signal())).rejects.toMatchObject({ code: 'stale_generation' });
    await s.destroyCompute(ref(), signal());
    expect(provider.terminate).toHaveBeenCalledWith('mvm-a', expect.any(AbortSignal));
    expect(await getUserMachine(db, 'ctr-1')).toMatchObject({ status: 'stopped', substrateRef: null });
  });

  it('lists provider compute for reconciliation', async () => {
    const { substrate: s } = substrate(fakeProvider());
    expect(await s.listCompute(signal())).toEqual([
      { computeRef: 'mvm-a', state: 'running', createdAt: T0.toISOString() },
      { computeRef: 'mvm-b', state: 'stopping', createdAt: null },
    ]);
  });
});
