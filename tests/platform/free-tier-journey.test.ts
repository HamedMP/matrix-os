import { isConnectablePhase } from '../../apps/mobile/lib/journey.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostdCapacityResponse, HostdCreateVmRequest } from '@matrix-os/contracts';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { loadCustomerVpsCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
import type { CustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import {
  completeUserMachineRegistration,
  getActiveUserMachineByClerkId,
  getBillingEntitlement,
  insertCheckoutAttempt,
  insertUserMachine,
  promoteHostBundleChannel,
  upsertBillingEntitlement,
  upsertHostBundleRelease,
  type PlatformDB,
  type UserMachineRecord,
} from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { addFreeTierInvite, getFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createFreeTierRuntime } from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import { createJourneyProvisioner } from '../../packages/platform/src/journey-provisioning.js';
import { deriveJourneyPhase } from '../../packages/platform/src/journey.js';
import { createJourneyRoutes } from '../../packages/platform/src/journey-routes.js';
import { AccountDeletionAdmissionError } from '../../packages/platform/src/account-deletion/admission.js';
import { resolveEffectiveBillingEntitlement } from '../../packages/platform/src/runtime-entitlement.js';
import type { HostdClient } from '../../packages/platform/src/substrates/hostd-client.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { HostdError } from '../../packages/platform/src/substrates/hostd-client.js';
import { createMetalProvisioner } from '../../packages/platform/src/substrates/metal-provisioner.js';
import { createMetalVmDeletionDrainer } from '../../packages/platform/src/substrates/metal-vm-deletions.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * Free plan in the onboarding journey (spec 092 + spec 2691, ENG-520). The
 * platform decides: an owner who can take the free plan sees the normal
 * install-choices step instead of plan_required, and starting provisioning
 * builds their free metal VM with no checkout. Faults detected: an invited
 * free owner sent to plans/checkout, the journey's provisioning call answering
 * 402 for them, a free owner's metal VM shown as plan_required, an uninvited
 * owner offered free compute, and a paid journey routed to metal.
 */

const OWNER = 'user_freeowner';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const APP_ORIGIN = 'https://app.matrix-os.com';
const BUNDLE_VERSION = 'matrix-os-host-2026.11.20-1';

function paidEntitlement(): BillingEntitlement {
  return {
    ...buildFreeEntitlement(OWNER, NOW), source: 'stripe', planSlug: 'matrix_starter', status: 'active',
    defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'], stripeSubscriptionId: 'sub_1', stripePriceId: 'price_1',
  };
}

function metalMachine(status: string): UserMachineRecord {
  return {
    machineId: 'metal-1', clerkUserId: OWNER, handle: 'freeowner', runtimeSlot: 'primary', status,
    substrate: 'metal', provisionedAt: NOW.toISOString(), hetznerServerId: null, publicIPv4: null, attempt: 1,
  } as unknown as UserMachineRecord;
}

describe('journey phase for the free plan', () => {
  const base = {
    checkoutAttempt: null, prebillingIntent: null, firstRun: null, now: NOW,
    settlingWindowMs: 600_000, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN,
  };

  it('offers an eligible owner with no entitlement the install step instead of plans', () => {
    expect(deriveJourneyPhase({ ...base, entitlement: null, liveMachine: null, freePlanEligible: true }).phase)
      .toBe('install_choices_required');
    expect(deriveJourneyPhase({ ...base, entitlement: null, liveMachine: null, freePlanEligible: false }).phase)
      .toBe('plan_required');
    expect(deriveJourneyPhase({ ...base, entitlement: null, liveMachine: null }).phase).toBe('plan_required');
  });

  it('offers free setup to an eligible owner despite a historical paid checkout', () => {
    const checkoutAttempt = { status: 'paid', createdAt: '2026-01-01T00:00:00.000Z' } as NonNullable<Parameters<typeof deriveJourneyPhase>[0]['checkoutAttempt']>;
    expect(deriveJourneyPhase({ ...base, checkoutAttempt, entitlement: null, liveMachine: null, freePlanEligible: true }).nextAction)
      .toEqual({ kind: 'start_provision' });
  });

  it.each(['suspended', 'suspending', 'resuming', 'stopped'])('hands Native Mobile an on-demand metal runtime in %s state', (status) => {
    const liveMachine = { ...metalMachine(status), metalVmId: 'vm_0123456789abcdef01234567' };
    const entitlement = buildFreeEntitlement(OWNER, NOW);
    const state = deriveJourneyPhase({ ...base, liveMachine, entitlement });
    expect(state).toMatchObject({ phase: 'first_run', nextAction: { kind: 'begin_first_run' } });
    expect(isConnectablePhase(state.phase)).toBe(true);

    const vps = { ...liveMachine, status: 'suspended', substrate: 'vps' } as const;
    expect(deriveJourneyPhase({ ...base, liveMachine: vps, entitlement: paidEntitlement() }).phase).toBe('provisioning');
  });

  it('follows a free owner through their metal runtime and never through a VPS', () => {
    const free = buildFreeEntitlement(OWNER, NOW);
    expect(deriveJourneyPhase({ ...base, entitlement: free, liveMachine: metalMachine('provisioning') }).phase).toBe('provisioning');
    expect(deriveJourneyPhase({ ...base, entitlement: free, liveMachine: metalMachine('running') }).phase).toBe('first_run');
    const vps = { ...metalMachine('running'), substrate: 'vps' } as UserMachineRecord;
    expect(deriveJourneyPhase({ ...base, entitlement: free, liveMachine: vps }).phase).toBe('plan_required');
  });
});

describe('onboarding journey on the free plan', () => {
  let db: PlatformDB;
  let template: string;
  let createVm: ReturnType<typeof vi.fn>;
  let capacity: ReturnType<typeof vi.fn>;
  let destroy: ReturnType<typeof vi.fn>;
  let clock: Date;
  let machineIds: string[];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb({ serializeTransactions: true }));
    clock = NOW;
    machineIds = ['6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e6f', '0f1e2d3c-4b5a-4968-8776-655443322110'];
    destroy = vi.fn(async () => undefined);
    await upsertHostBundleRelease(db, {
      version: BUNDLE_VERSION, gitCommit: '1234567', buildTime: NOW.toISOString(),
      bundleKey: `system-bundles/${BUNDLE_VERSION}/matrix-host-bundle.tar.gz`, checksumKey: null,
      sha256: 'c'.repeat(64), size: 100, createdAt: NOW.toISOString(),
    });
    await promoteHostBundleChannel(db, 'stable', BUNDLE_VERSION, NOW.toISOString());
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    template = await loadCustomerVpsCloudInitTemplate();
    capacity = vi.fn(async (): Promise<HostdCapacityResponse> => ({
      memoryAvailableMiB: 60_000, poolFreeBytes: 1024 * 1024 ** 3, runningVms: 0, suspendedVms: 0, thinPool: { dataPercent: 20, metadataPercent: 5 },
    }));
    createVm = vi.fn(async (_spec: HostdCreateVmRequest) => ({ id: 'vm_0123456789abcdef01234567', privateIPv4: '10.77.0.9' }));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function journeyApp(options: { resolveEntitlement?: () => Promise<BillingEntitlement | null>; stripeEnabled?: boolean; maxRuntimes?: number } = {}) {
    const unused = async () => { throw new Error('unexpected hostd call'); };
    const client = {
      capacity, createVm, listVms: async () => [], destroy, getVm: unused,
      resume: unused, suspend: unused, stop: unused, setPolicy: unused,
    } as unknown as HostdClient;
    // Wired as metal-runtime does, with no maintenance worker (Cloud Run).
    const drainer = createMetalVmDeletionDrainer({
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => client, now: () => clock, log: () => {},
    });
    const metal = createMetalProvisioner({
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => client,
      goldenVersion: BUNDLE_VERSION, config: createTestConfig(), cloudInitTemplate: template,
      drainMachineDeletions: (machineId, signal) => drainer.drainMachine(machineId, signal),
      now: () => clock, sleep: async () => undefined, machineIdFactory: () => machineIds.shift() ?? 'unexpected-machine',
      tokenFactory: () => ({ token: 'registration-token', hash: hashRegistrationToken('registration-token'), expiresAt: '2026-11-21T13:00:00.000Z' }),
      postgresPasswordFactory: () => 'postgres-secret', log: () => {},
    });
    const freeTier = createFreeTierRuntime({ db, config: { maxRuntimes: options.maxRuntimes ?? 10, inviteRequired: true }, metal, env: {} });
    const provision = vi.fn<CustomerVpsService['provision']>(async () => ({
      machineId: 'vps-machine', status: 'provisioning',
    }) as unknown as Awaited<ReturnType<CustomerVpsService['provision']>>);
    const provisionRuntime = createJourneyProvisioner({
      db,
      appEnv: {},
      customerVpsService: { provision } as Partial<CustomerVpsService> as CustomerVpsService,
      freeRuntimeProvisioner: freeTier?.provisioner,
      stripeBillingEntitlementsEnabled: () => options.stripeEnabled ?? true,
      resolveEffectiveBillingEntitlement: options.resolveEntitlement
        ?? ((routeDb, clerkUserId, now, runtimeSlot) => resolveEffectiveBillingEntitlement(routeDb, clerkUserId, now, runtimeSlot, {})),
      selectProvisionIdentityForClerkUser: async (_db, userId) => ({ handle: userId.replace('user_', ''), displayName: 'Owner' }),
      ensureProvisionedPlatformUser: async () => {},
    });
    const app = createJourneyRoutes({
      db,
      resolveUserId: async () => OWNER,
      provisionRuntime,
      resolveFreePlanEligibility: freeTier?.provisioner?.isEligible,
      reconcileStaleRuntime: freeTier?.provisioner?.reconcileStaleRuntime,
      appOrigin: APP_ORIGIN,
      env: {},
      maxProvisionAttempts: 3,
      now: () => clock,
    });
    return { app, provision };
  }

  async function journey(app: ReturnType<typeof journeyApp>['app']) {
    return (await (await app.request('/api/journey')).json()) as { phase: string; nextAction: { kind: string } };
  }

  function retry(app: ReturnType<typeof journeyApp>['app']) {
    return app.request('/api/journey/retry-provision', { method: 'POST', body: '{}' });
  }

  it('requires admission for an uninvited owner when Stripe is disabled', async () => {
    const { app, provision } = journeyApp({ stripeEnabled: false });

    expect(await journey(app)).toMatchObject({ phase: 'plan_required' });
    const result = await retry(app);
    expect(result.status).toBe(402);
    expect(await result.json()).toMatchObject({ error: 'billing_required' });
    expect(provision).not.toHaveBeenCalled();
    expect(createVm).not.toHaveBeenCalled();
  });

  it.each([true, false])('an invited free owner reaches provisioning when Stripe enabled is %s', async (stripeEnabled) => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app, provision } = journeyApp({ stripeEnabled });

    // Free owners need no install choices; clients that cannot show them (Native Mobile) start the build directly.
    expect(await journey(app)).toMatchObject({ phase: 'install_choices_required', nextAction: { kind: 'start_provision' } });

    const started = await retry(app);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ status: 'started', journey: { phase: 'provisioning' } });
    expect(createVm).toHaveBeenCalledTimes(1);
    expect(createVm.mock.calls[0]![0]).toMatchObject({ tier: 'free' });
    expect(provision).not.toHaveBeenCalled();
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'free' });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeInstanceOf(Date);

    // The guest registers: the journey moves on to the normal first-run state.
    await db.executor.updateTable('user_machines').set({ status: 'running' }).where('clerk_user_id', '=', OWNER).execute();
    expect((await journey(app)).phase).toBe('first_run');
  });

  it('answers a full free plan with the capacity code so clients can say so (ENG-520)', async () => {
    await addFreeTierInvite(db, { clerkUserId: 'user_someoneelse', invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...buildFreeEntitlement('user_someoneelse', NOW) });
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app } = journeyApp({ maxRuntimes: 1 });

    const result = await retry(app);
    expect(result.status).toBe(503);
    expect(result.headers.get('retry-after')).toBe('60');
    expect(await result.json()).toEqual({ error: 'busy' });
    expect(createVm).not.toHaveBeenCalled();
  });

  it('a first build whose guest never registers turns retryable on the journey, with no maintenance worker', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app } = journeyApp();
    expect((await retry(app)).status).toBe(200);
    expect((await journey(app)).phase).toBe('provisioning');

    // The registration window (1 h) closes with the guest never registered.
    clock = new Date('2026-11-21T14:00:00.000Z');
    expect(await journey(app)).toMatchObject({ phase: 'provisioning_failed', nextAction: { kind: 'retry_provision' } });
    expect(await getActiveUserMachineByClerkId(db, OWNER, 'primary'))
      .toMatchObject({ status: 'failed', failureCode: 'registration_timeout' });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledWith('vm_0123456789abcdef01234567', expect.any(AbortSignal)));

    // Try again builds a fresh VM.
    const again = await retry(app);
    expect(await again.json()).toMatchObject({ status: 'started', journey: { phase: 'provisioning' } });
    expect(createVm).toHaveBeenCalledTimes(2);
  });

  it('answers the journey without waiting for the stuck VM\'s teardown', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    let release!: () => void;
    destroy.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const { app } = journeyApp();
    expect((await retry(app)).status).toBe(200);

    clock = new Date('2026-11-21T14:00:00.000Z');
    // The destroy is still pending, yet the journey has already answered.
    expect((await journey(app)).phase).toBe('provisioning_failed');
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(async () => expect(await db.executor.selectFrom('metal_vm_deletions')
      .select('completed_at').executeTakeFirst()).toMatchObject({ completed_at: expect.anything() }));
  });

  it('concurrent journey reads after expiry fail the build once and destroy its VM once', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app } = journeyApp();
    expect((await retry(app)).status).toBe(200);

    clock = new Date('2026-11-21T14:00:00.000Z');
    const answers = await Promise.all([journey(app), journey(app), journey(app)]);

    expect(answers.map((answer) => answer.phase)).toEqual(['provisioning_failed', 'provisioning_failed', 'provisioning_failed']);
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(await db.executor.selectFrom('metal_vm_deletions').select('machine_id').execute()).toHaveLength(1);
  });

  it('a registration that commits just before the read-path check keeps the runtime', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app } = journeyApp();
    expect((await retry(app)).status).toBe(200);
    const row = await getActiveUserMachineByClerkId(db, OWNER, 'primary');

    // /vps/register commits inside the window (its own guards: valid token, provisioning).
    const registered = await completeUserMachineRegistration(db, row!.machineId, 'metal',
      row!.registrationTokenHash!, '2026-11-21T12:30:00.000Z',
      { status: 'running', lastSeenAt: '2026-11-21T12:30:00.000Z', registrationTokenHash: null, registrationTokenExpiresAt: null });
    expect(registered?.status).toBe('running');

    clock = new Date('2026-11-21T14:00:00.000Z');
    expect((await journey(app)).phase).not.toBe('provisioning_failed');
    expect(await getActiveUserMachineByClerkId(db, OWNER, 'primary')).toMatchObject({ status: 'running' });
    expect(await db.executor.selectFrom('metal_vm_deletions').select('machine_id').execute()).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('a registration attempted after the read path failed the build is refused', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app } = journeyApp();
    expect((await retry(app)).status).toBe(200);
    const row = await getActiveUserMachineByClerkId(db, OWNER, 'primary');

    clock = new Date('2026-11-21T14:00:00.000Z');
    expect((await journey(app)).phase).toBe('provisioning_failed');
    expect(await completeUserMachineRegistration(db, row!.machineId, 'metal',
      row!.registrationTokenHash!, clock.toISOString(), { status: 'running' })).toBeUndefined();
    expect(await getActiveUserMachineByClerkId(db, OWNER, 'primary')).toMatchObject({ status: 'failed' });
  });

  it('the retry route also fails an expired build instead of reporting it in progress', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app } = journeyApp();
    expect((await retry(app)).status).toBe(200);

    clock = new Date('2026-11-21T14:00:00.000Z');
    const again = await retry(app);
    expect(await again.json()).toMatchObject({ status: 'started' });
    expect(createVm).toHaveBeenCalledTimes(2);
  });

  it('never offers a retry that would retire a paid computer which ran and then failed recovery', async () => {
    await upsertBillingEntitlement(db, paidEntitlement());
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: OWNER, handle: 'freeowner', status: 'failed', failureCode: 'provider_unavailable',
      hetznerServerId: 4343, publicIPv4: null, recoveryOldServerId: 4242, recoveryOldPublicIPv4: '203.0.113.50',
      imageVersion: BUNDLE_VERSION, provisionedAt: NOW.toISOString(),
    });
    const { app, provision } = journeyApp({ resolveEntitlement: async () => paidEntitlement() });

    expect(await journey(app)).toMatchObject({ phase: 'provisioning_failed', nextAction: { kind: 'contact_support' } });
    const refused = await retry(app);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'support_required' });
    expect(provision).not.toHaveBeenCalled();
    expect(await getActiveUserMachineByClerkId(db, OWNER, 'primary')).toMatchObject({ machineId: 'vps-1', status: 'failed' });
  });

  it('stops offering free metal retries after the attempt ceiling and throttles rapid retries', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    machineIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'];
    createVm.mockRejectedValue(new HostdError('internal'));
    const { app } = journeyApp();

    // Each build fails at hostd create; the route answers 503 and the row is failed.
    expect((await retry(app)).status).toBe(503);
    expect((await getActiveUserMachineByClerkId(db, OWNER, 'primary'))?.attempt).toBe(1);
    // A second click inside the throttle window does not reach hostd.
    const throttled = await retry(app);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: 'retry_throttled' });
    expect(createVm).toHaveBeenCalledTimes(1);

    for (const minute of [1, 2]) {
      clock = new Date(NOW.getTime() + minute * 60_000);
      expect(await journey(app)).toMatchObject({ phase: 'provisioning_failed', nextAction: { kind: 'retry_provision' } });
      expect((await retry(app)).status).toBe(503);
    }
    expect((await getActiveUserMachineByClerkId(db, OWNER, 'primary'))?.attempt).toBe(3);

    clock = new Date(NOW.getTime() + 3 * 60_000);
    expect(await journey(app)).toMatchObject({ phase: 'provisioning_failed', nextAction: { kind: 'contact_support' } });
    const exhausted = await retry(app);
    expect(exhausted.status).toBe(409);
    expect(await exhausted.json()).toEqual({ error: 'retry_exhausted' });
    expect(createVm).toHaveBeenCalledTimes(3);
  });

  it('an owner who bought a paid plan after three failed free builds can still build', async () => {
    await upsertBillingEntitlement(db, paidEntitlement());
    await insertUserMachine(db, {
      machineId: 'metal-failed', clerkUserId: OWNER, handle: 'freeowner', status: 'failed', failureCode: 'registration_timeout',
      substrate: 'metal', metalHostId: 'host-a', hetznerServerId: null, publicIPv4: null, attempt: 3, imageVersion: BUNDLE_VERSION,
      provisionedAt: NOW.toISOString(),
    });
    const { app, provision } = journeyApp({ resolveEntitlement: async () => paidEntitlement() });

    expect(await journey(app)).toMatchObject({ phase: 'provisioning_failed', nextAction: { kind: 'retry_provision' } });
    expect((await retry(app)).status).toBe(200);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('an uninvited owner still sees plan_required and cannot start provisioning', async () => {
    const { app, provision } = journeyApp();

    expect(await journey(app)).toMatchObject({ phase: 'plan_required', nextAction: { kind: 'open_plans' } });
    const refused = await retry(app);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: 'billing_required' });
    expect(createVm).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
  });

  it('a paid journey is unchanged', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, paidEntitlement());
    const { app, provision } = journeyApp({ resolveEntitlement: async () => paidEntitlement() });

    expect(await journey(app)).toMatchObject({ phase: 'install_choices_required', nextAction: { kind: 'choose_default_installs' } });
    const started = await retry(app);
    expect(started.status).toBe(200);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(createVm).not.toHaveBeenCalled();
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
  });

  it('keeps an invited owner with a settling paid checkout on the paid flow', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await insertCheckoutAttempt(db, { id: 'att-1', clerkUserId: OWNER, stripeSessionId: 'cs_open', createdAt: new Date(Date.now() - 60_000).toISOString() });
    const { app, provision } = journeyApp();
    expect((await journey(app)).phase).toBe('payment_settling');
    expect((await retry(app)).status).toBe(402);
    expect(createVm).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
  });

  it('keeps an invited owner with an older open paid checkout out of the free plan', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await insertCheckoutAttempt(db, { id: 'att-old', clerkUserId: OWNER, stripeSessionId: 'cs_open_old', createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString() });
    const { app } = journeyApp();
    expect((await journey(app)).phase).toBe('plan_required');
    expect((await retry(app)).status).toBe(402);
    expect(createVm).not.toHaveBeenCalled();
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
  });

  it('answers a pending account deletion during journey provisioning with its own code', async () => {
    const app = createJourneyRoutes({
      db, resolveUserId: async () => OWNER, appOrigin: APP_ORIGIN, env: {}, maxProvisionAttempts: 3, now: () => NOW,
      provisionRuntime: async () => { throw new AccountDeletionAdmissionError(); },
    });
    const response = await app.request('/api/journey/retry-provision', { method: 'POST', body: '{}' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'account_deletion_pending' });
  });

  // ENG-520 P7 (ported from PR #3437): a lapsed paid owner whose subscription
  // has not ended (here unpaid) keeps paid plans; one whose paid rights have
  // all ended is offered the free plan (P5 kept every lapsed paid owner on
  // plan_required).
  it('keeps an unpaid paid owner on plan_required even with an invite', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...paidEntitlement(), status: 'unpaid' });
    const { app } = journeyApp();
    expect((await journey(app)).phase).toBe('plan_required');
    expect((await retry(app)).status).toBe(402);
    expect(createVm).not.toHaveBeenCalled();
  });

  it('offers the free plan to an invited former paid owner whose paid rights have ended', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...paidEntitlement(), status: 'canceled' });
    const { app } = journeyApp();
    expect((await journey(app)).phase).not.toBe('plan_required');
  });

  it('keeps an owner with a VPS in the slot out of the free plan', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: OWNER, handle: 'freeowner', status: 'failed', imageVersion: 'v1',
      provisionedAt: NOW.toISOString(), activationState: 'authorized',
    });
    const { app } = journeyApp();
    expect((await journey(app)).phase).toBe('plan_required');
    expect(createVm).not.toHaveBeenCalled();
  });
});
