import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeStateSchema } from '@matrix-os/contracts';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { createAuthRoutes } from '../../packages/platform/src/auth-routes.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import {
  insertUserMachine,
  upsertBillingEntitlement,
  upsertOnboardingFirstRun,
  type PlatformDB,
  type UserMachineRecord,
} from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { deriveJourneyPhase, loadJourney, type JourneyDerivationInputs } from '../../packages/platform/src/journey.js';
import { containerRuntimeState } from '../../packages/platform/src/substrates/container-runtime-state.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const APP_ORIGIN = 'https://app.matrix-os.com';
const OWNER = 'user_freeowner';
const JWT_SECRET = 'j'.repeat(40);

function container(status: string, overrides: Partial<UserMachineRecord> = {}): UserMachineRecord {
  return {
    machineId: 'ctr-1', clerkUserId: OWNER, handle: 'freeowner', runtimeSlot: 'primary', runtimeTokenEpoch: 1,
    provisioningClass: 'free', developerTools: [], hetznerServerId: null, publicIPv4: null, publicIPv6: null,
    status, imageVersion: null, serverType: null, registrationTokenHash: null, registrationTokenExpiresAt: null,
    provisionedAt: '2026-11-11T11:00:00.000Z', lastSeenAt: null, deletedAt: null, failureCode: null,
    failureAt: null, attempt: 1, substrate: 'container', generation: 1, substrateRef: null, privateAddress: null,
    ...overrides,
  } as UserMachineRecord;
}

function paid(): BillingEntitlement {
  return {
    ...buildFreeEntitlement(OWNER, NOW), source: 'stripe', planSlug: 'matrix_builder',
    defaultServerType: 'cpx42', allowedServerTypes: ['cpx42'], stripeSubscriptionId: 'sub_1', stripePriceId: 'price_1',
  };
}

function derive(partial: Partial<JourneyDerivationInputs>) {
  return deriveJourneyPhase({
    entitlement: buildFreeEntitlement(OWNER, NOW), checkoutAttempt: null, liveMachine: null, prebillingIntent: null,
    firstRun: { clerkUserId: OWNER, completedAt: NOW.toISOString(), goal: null, source: 'write_behind' },
    now: NOW, settlingWindowMs: 600_000, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN, ...partial,
  });
}

describe('container runtime state', () => {
  it.each([
    ['running', null, 'ready'], ['stopped', null, 'ready'], ['starting', null, 'waking'],
    ['provisioning', null, 'waking'], ['quiescing', null, 'waking'], ['failed_start', 'busy', 'busy'],
    ['failed_start', 'start_timeout', 'failed'], ['needs_recovery', 'quiesce_timeout', 'failed'],
    ['migrating', null, 'migrating'], ['something_new', null, 'failed'],
  ])('maps %s (%s) to %s', (status, failureCode, expected) => {
    const state = containerRuntimeState({ status, failureCode });
    expect(state).toBe(expected);
    expect(RuntimeStateSchema.safeParse(state).success).toBe(true);
  });
});

describe('journey phases for a free container runtime', () => {
  it('opens the shell for a stopped runtime, because the first owner request wakes it', () => {
    expect(derive({ liveMachine: container('stopped') })).toEqual({
      phase: 'ready', detail: 'Your Matrix computer is ready.',
      nextAction: { kind: 'open_shell', url: `${APP_ORIGIN}/` },
      runtime: { substrate: 'container', state: 'ready' },
    });
  });

  it('reports waking and busy without a billing gate', () => {
    expect(derive({ liveMachine: container('starting') })).toMatchObject({ phase: 'ready', runtime: { state: 'waking' } });
    expect(derive({ liveMachine: container('failed_start', { failureCode: 'busy' }) }))
      .toMatchObject({ phase: 'ready', runtime: { state: 'busy' } });
  });

  it('starts first run on a container that has not finished onboarding', () => {
    expect(derive({ liveMachine: container('running'), firstRun: null }))
      .toMatchObject({ phase: 'first_run', runtime: { substrate: 'container', state: 'ready' } });
  });

  it('sends a container that needs recovery to support', () => {
    expect(derive({ liveMachine: container('needs_recovery', { failureCode: 'quiesce_timeout' }) })).toMatchObject({
      phase: 'provisioning_failed', nextAction: { kind: 'contact_support' }, runtime: { state: 'failed' },
    });
  });

  it('shows a migrating container as waiting', () => {
    expect(derive({ liveMachine: container('migrating') }))
      .toMatchObject({ phase: 'provisioning', nextAction: { kind: 'wait' }, runtime: { state: 'migrating' } });
  });

  it('never lets a free entitlement admit a VPS', () => {
    const vps = container('running', { substrate: 'vps', provisioningClass: 'customer' });
    expect(derive({ liveMachine: vps })).toMatchObject({ phase: 'plan_required' });
  });

  it('leaves VPS journeys without a runtime field', () => {
    const vps = container('running', { substrate: 'vps', provisioningClass: 'customer' });
    const state = derive({ entitlement: paid(), liveMachine: vps });
    expect(state).toEqual({
      phase: 'ready', detail: 'Your Matrix computer is ready.', nextAction: { kind: 'open_shell', url: `${APP_ORIGIN}/` },
    });
  });
});

describe('container runtime through the journey loader and device sign-in', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'freeowner', status: 'stopped', imageVersion: null,
      provisionedAt: NOW.toISOString(), substrate: 'container',
    });
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('loads a ready journey for the primary slot from stored records', async () => {
    await upsertOnboardingFirstRun(db, { clerkUserId: OWNER, completedAt: NOW.toISOString(), goal: null, source: 'write_behind' });
    const state = await loadJourney(OWNER, {
      db, now: () => NOW, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN, runtimeSlot: 'primary', env: {}, recordTransition: false,
    });
    expect(state).toMatchObject({ phase: 'ready', runtime: { substrate: 'container', state: 'ready' } });
  });

  async function signIn(runtimeSlot?: string) {
    const app = createAuthRoutes({
      db, jwtSecret: JWT_SECRET, platformUrl: 'https://app.matrix-os.com',
      gatewayUrlForHandle: (handle) => `https://app.matrix-os.com/vm/${handle}`,
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      ignoreLegacyContainers: true,
    });
    const code = await (await app.request('/api/auth/device/code', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'matrixos-cli' }),
    })).json() as { userCode: string; deviceCode: string };
    const page = await app.request(`/auth/device?user_code=${code.userCode}`);
    const csrf = (page.headers.get('set-cookie') ?? '').match(/device_csrf=([^;]+)/)![1]!;
    const approval = await app.request('/auth/device/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${OWNER}`, cookie: `device_csrf=${csrf}` },
      body: new URLSearchParams({ userCode: code.userCode, csrf, ...(runtimeSlot ? { runtimeSlot } : {}) }).toString(),
    });
    const token = await app.request('/api/auth/device/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: code.deviceCode }),
    });
    return { approval, token };
  }

  it('signs a device in to a stopped container and reports its runtime state', async () => {
    const { approval, token } = await signIn();
    expect(approval.status).toBe(200);
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({
      handle: 'freeowner', userId: OWNER, runtime: { substrate: 'container', state: 'ready' },
    });
  });

  it('approves a stopped container when the device selects its slot', async () => {
    const { approval, token } = await signIn('primary');
    expect(approval.status).toBe(200);
    expect(await token.json()).toMatchObject({ handle: 'freeowner', runtimeSlot: 'primary', runtime: { state: 'ready' } });
  });

  it('adds no runtime field for a VPS sign-in', async () => {
    await db.executor.updateTable('user_machines').set({ deleted_at: NOW.toISOString() }).execute();
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: OWNER, handle: 'freeowner', status: 'running', imageVersion: 'v',
      provisionedAt: NOW.toISOString(),
    });
    const { token } = await signIn();
    const body = await token.json() as Record<string, unknown>;
    expect(body.handle).toBe('freeowner');
    expect(body).not.toHaveProperty('runtime');
  });
});
