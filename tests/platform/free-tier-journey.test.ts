import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostdCapacityResponse, HostdCreateVmRequest } from '@matrix-os/contracts';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { loadCustomerVpsCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
import type { CustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import {
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
import { createMetalProvisioner } from '../../packages/platform/src/substrates/metal-provisioner.js';
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

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb({ serializeTransactions: true }));
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
      memoryAvailableMiB: 60_000, poolFreeBytes: 1024 * 1024 ** 3, runningVms: 0, suspendedVms: 0,
    }));
    createVm = vi.fn(async (_spec: HostdCreateVmRequest) => ({ id: 'vm_0123456789abcdef01234567', privateIPv4: '10.77.0.9' }));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function journeyApp(options: { resolveEntitlement?: () => Promise<BillingEntitlement | null> } = {}) {
    const unused = async () => { throw new Error('unexpected hostd call'); };
    const client = {
      capacity, createVm, listVms: unused, destroy: unused, getVm: unused,
      resume: unused, suspend: unused, stop: unused, setPolicy: unused,
    } as unknown as HostdClient;
    const metal = createMetalProvisioner({
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => client,
      goldenVersion: 'golden-2026.11.20-1', config: createTestConfig(), cloudInitTemplate: template,
      now: () => NOW, sleep: async () => undefined, machineIdFactory: () => '6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e6f',
      tokenFactory: () => ({ token: 'registration-token', hash: hashRegistrationToken('registration-token'), expiresAt: '2026-11-21T13:00:00.000Z' }),
      postgresPasswordFactory: () => 'postgres-secret', log: () => {},
    });
    const freeTier = createFreeTierRuntime({ db, config: { maxRuntimes: 10, inviteRequired: true }, metal, env: {} });
    const provision = vi.fn<CustomerVpsService['provision']>(async () => ({
      machineId: 'vps-machine', status: 'provisioning',
    }) as unknown as Awaited<ReturnType<CustomerVpsService['provision']>>);
    const provisionRuntime = createJourneyProvisioner({
      db,
      appEnv: {},
      customerVpsService: { provision } as Partial<CustomerVpsService> as CustomerVpsService,
      freeRuntimeProvisioner: freeTier?.provisioner,
      stripeBillingEntitlementsEnabled: () => true,
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
      appOrigin: APP_ORIGIN,
      env: {},
      maxProvisionAttempts: 3,
      now: () => NOW,
    });
    return { app, provision };
  }

  async function journey(app: ReturnType<typeof journeyApp>['app']) {
    return (await (await app.request('/api/journey')).json()) as { phase: string; nextAction: { kind: string } };
  }

  function retry(app: ReturnType<typeof journeyApp>['app']) {
    return app.request('/api/journey/retry-provision', { method: 'POST', body: '{}' });
  }

  it('an invited free owner reaches provisioning with no checkout', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { app, provision } = journeyApp();

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

  it('keeps a lapsed paid owner on plan_required even with an invite', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...paidEntitlement(), status: 'canceled' });
    const { app } = journeyApp();
    expect((await journey(app)).phase).toBe('plan_required');
    expect((await retry(app)).status).toBe(402);
    expect(createVm).not.toHaveBeenCalled();
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
