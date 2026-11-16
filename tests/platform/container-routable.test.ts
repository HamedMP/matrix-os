import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import { ContainerProviderError, type ContainerProvider } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerSubstrate } from '../../packages/platform/src/substrates/container-substrate.js';
import { decideContainerWake } from '../../packages/platform/src/substrates/container-websocket.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const HOST = 'mvm-a.lambda-microvm.eu-west-1.on.aws';
const OWNER = 'user_owner';

function fakeProvider(overrides: Partial<ContainerProvider> = {}): ContainerProvider {
  return {
    run: vi.fn(async () => { throw new Error('must not run'); }),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => { throw new Error('must not resume'); }),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { headers: { 'X-aws-proxy-auth': 'minted', 'X-aws-proxy-port': '4000' }, expiresAt: new Date(Date.now() + 30 * 60_000) };
    }),
    ...overrides,
  };
}

describe('non-owner access to a container on an instance without a cached credential', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  async function seed(status: string, extra: { substrateRef?: string | null; privateAddress?: string | null } = {}) {
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'owner', status, imageVersion: null,
      provisionedAt: new Date().toISOString(), substrate: 'container', generation: 3,
      substrateRef: extra.substrateRef === undefined ? 'mvm-a' : extra.substrateRef,
      privateAddress: extra.privateAddress === undefined ? HOST : extra.privateAddress,
    });
  }

  function setup(provider: ContainerProvider) {
    const lifecycle = createContainerLifecycleService({ db, provider, buildBootPayload: async () => '{}' });
    const markComputeLost = vi.spyOn(lifecycle, 'markComputeLost');
    const ensureStarted = vi.spyOn(lifecycle, 'ensureStarted');
    const substrate = createContainerSubstrate({
      lifecycle, provider, endpointHostSuffix: '.on.aws', loadMachine: (machineId) => getUserMachine(db, machineId),
    });
    return { substrate, registry: createSubstrateRegistry([substrate]), markComputeLost, ensureStarted, lifecycle };
  }

  const collaborator = { userId: 'user_collaborator', source: 'auth' };

  async function decide(registry: ReturnType<typeof setup>['registry'], identity: { userId: string; source?: string }) {
    const machine = (await getUserMachine(db, 'ctr-1'))!;
    return decideContainerWake({ db, substrates: registry, machine, identity, logError: () => {} });
  }

  it('lets a collaborator reach a running unit by minting a credential, without any lifecycle change', async () => {
    await seed('running');
    const provider = fakeProvider();
    const { registry, ensureStarted } = setup(provider);
    const decision = await decide(registry, collaborator);
    expect(decision.kind).toBe('proceed');
    const machine = (await getUserMachine(db, 'ctr-1'))!;
    const resolution = registry.resolveUpstream(machine, { path: '/api/x' });
    expect(resolution).toMatchObject({ kind: 'upstream', upstream: { url: `https://${HOST}/api/x`, headers: { 'X-aws-proxy-auth': 'minted' } } });
    expect(provider.mintEndpointCredential).toHaveBeenCalledTimes(1);
    expect(provider.run).not.toHaveBeenCalled();
    expect(provider.resume).not.toHaveBeenCalled();
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(machine).toMatchObject({ status: 'running', generation: 3 });
  });

  it.each(['stopped', 'starting', 'quiescing', 'failed_start', 'needs_recovery'])(
    'never mints, runs, or resumes for a collaborator when the runtime is %s', async (status) => {
      await seed(status);
      const provider = fakeProvider();
      const { registry, ensureStarted } = setup(provider);
      expect(await decide(registry, collaborator)).toEqual({ kind: 'unavailable' });
      expect(provider.mintEndpointCredential).not.toHaveBeenCalled();
      expect(provider.run).not.toHaveBeenCalled();
      expect(provider.resume).not.toHaveBeenCalled();
      expect(ensureStarted).not.toHaveBeenCalled();
      expect((await getUserMachine(db, 'ctr-1'))?.status).toBe(status);
    });

  it('mints once for twenty concurrent collaborator requests', async () => {
    await seed('running');
    const provider = fakeProvider();
    const { registry } = setup(provider);
    const decisions = await Promise.all(Array.from({ length: 20 }, () => decide(registry, collaborator)));
    expect(decisions.every((decision) => decision.kind === 'proceed')).toBe(true);
    expect(provider.mintEndpointCredential).toHaveBeenCalledTimes(1);
  });

  it('answers unavailable on a mint failure without marking compute lost', async () => {
    await seed('running');
    const provider = fakeProvider({ mintEndpointCredential: vi.fn(async () => { throw new ContainerProviderError('not_found'); }) });
    const { registry, markComputeLost } = setup(provider);
    expect(await decide(registry, collaborator)).toEqual({ kind: 'unavailable' });
    expect(markComputeLost).not.toHaveBeenCalled();
    expect(provider.describe).not.toHaveBeenCalled();
    expect((await getUserMachine(db, 'ctr-1'))).toMatchObject({ status: 'running', substrateRef: 'mvm-a' });
  });

  it('does not cache a credential minted while the unit was replaced', async () => {
    await seed('running');
    const provider = fakeProvider({
      mintEndpointCredential: vi.fn(async () => {
        await db.executor.updateTable('user_machines').set({ generation: 4, substrate_ref: 'mvm-b' }).execute();
        return { headers: { 'X-aws-proxy-auth': 'stale' }, expiresAt: new Date(Date.now() + 1_800_000) };
      }),
    });
    const { registry } = setup(provider);
    expect(await decide(registry, collaborator)).toEqual({ kind: 'unavailable' });
    const machine = (await getUserMachine(db, 'ctr-1'))!;
    expect(registry.resolveUpstream({ ...machine, substrateRef: 'mvm-a', generation: 3 }, { path: '/' }).kind).toBe('not_routable');
  });

  it('does not wake for a share-link identity carrying the owner user id', async () => {
    await seed('stopped', { substrateRef: null, privateAddress: null });
    const provider = fakeProvider();
    const { registry, ensureStarted } = setup(provider);
    expect(await decide(registry, { userId: OWNER, source: 'static-route' })).toEqual({ kind: 'unavailable' });
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
    expect(provider.mintEndpointCredential).not.toHaveBeenCalled();
  });
});
