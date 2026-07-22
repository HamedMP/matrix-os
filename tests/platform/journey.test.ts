import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  backfillFirstRunRecords,
  deriveJourneyPhase,
  loadJourney,
  type JourneyDerivationInputs,
} from '../../packages/platform/src/journey.js';
import type { BillingEntitlement, BillingEntitlementStatus } from '../../packages/platform/src/billing.js';
import type {
  BillingCheckoutAttemptRecord,
  UserMachineRecord,
  PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  getLatestJourneyEvent,
  getOnboardingFirstRun,
  insertCheckoutAttempt,
  insertUserMachine,
  resolveCheckoutAttempt,
  upsertOnboardingFirstRun,
} from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const APP_ORIGIN = 'https://app.matrix-os.com';

function entitlement(status: BillingEntitlementStatus, overrides: Partial<BillingEntitlement> = {}): BillingEntitlement {
  return {
    clerkUserId: 'user_123',
    source: 'stripe',
    planSlug: 'matrix_builder',
    status,
    maxRuntimeSlots: 1,
    includedRuntimeSlots: 1,
    addonRuntimeSlots: 0,
    defaultServerType: 'cpx32',
    allowedServerTypes: ['cpx32'],
    stripeSubscriptionId: 'sub_1',
    stripePriceId: 'price_1',
    gracePeriodEndsAt: null,
    effectiveFrom: '2026-06-01T00:00:00.000Z',
    effectiveUntil: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function attempt(status: BillingCheckoutAttemptRecord['status'], createdAt: string): BillingCheckoutAttemptRecord {
  return {
    id: 'a1',
    clerkUserId: 'user_123',
    stripeSessionId: 'cs_1',
    checkoutUrl: 'https://checkout.stripe.test/session',
    runtimeSlot: 'primary',
    planSlug: 'matrix_builder',
    billingInterval: 'monthly',
    regionSlug: 'region_fsn1',
    serverType: 'cpx32',
    status,
    developerTools: ['codex', 'claude-code', 'opencode', 'pi'],
    createdAt,
    resolvedAt: null,
  };
}

function machine(status: string, overrides: Partial<UserMachineRecord> = {}): UserMachineRecord {
  return {
    machineId: 'm1', clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary',
    provisioningClass: 'customer',
    developerTools: ['codex', 'claude-code', 'opencode', 'pi'],
    hetznerServerId: null, publicIPv4: null, publicIPv6: null, status,
    imageVersion: 'stable', serverType: 'cpx32', registrationTokenHash: null,
    registrationTokenExpiresAt: null, provisionedAt: '2026-06-11T11:59:00.000Z',
    lastSeenAt: null, deletedAt: null, failureCode: null, failureAt: null, attempt: 1,
    ...overrides,
  };
}

function derive(partial: Partial<JourneyDerivationInputs>): ReturnType<typeof deriveJourneyPhase> {
  return deriveJourneyPhase({
    entitlement: null,
    checkoutAttempt: null,
    liveMachine: null,
    firstRun: null,
    now: NOW,
    settlingWindowMs: 10 * 60 * 1000,
    maxProvisionAttempts: 3,
    appOrigin: APP_ORIGIN,
    ...partial,
  });
}

describe('platform/journey deriveJourneyPhase', () => {
  it('no entitlement and no attempt → plan_required', () => {
    const s = derive({});
    expect(s.phase).toBe('plan_required');
    expect(s.nextAction.kind).toBe('open_plans');
    expect(s.nextAction.url).toContain('plans=1');
  });

  it('open attempt within window → payment_settling (not delayed)', () => {
    const s = derive({ checkoutAttempt: attempt('open', '2026-06-11T11:55:00.000Z') });
    expect(s.phase).toBe('payment_settling');
    expect(s.settling?.delayed).toBe(false);
    expect(s.nextAction.kind).toBe('wait');
  });

  it('paid attempt within window → payment_settling (not delayed)', () => {
    const s = derive({
      entitlement: entitlement('incomplete'),
      checkoutAttempt: attempt('paid', '2026-06-11T11:58:00.000Z'),
    });
    expect(s.phase).toBe('payment_settling');
    expect(s.settling?.delayed).toBe(false);
  });

  it('paid attempt past window → payment_settling delayed with contact_support (never plan_required)', () => {
    const s = derive({ checkoutAttempt: attempt('paid', '2026-06-11T11:40:00.000Z') });
    expect(s.phase).toBe('payment_settling');
    expect(s.settling?.delayed).toBe(true);
    expect(s.nextAction.kind).toBe('contact_support');
  });

  it('open attempt past window → plan_required (abandoned checkout is not trapped)', () => {
    const s = derive({ checkoutAttempt: attempt('open', '2026-06-11T11:40:00.000Z') });
    expect(s.phase).toBe('plan_required');
  });

  it('expired attempt → plan_required', () => {
    const s = derive({ checkoutAttempt: attempt('expired', '2026-06-11T11:58:00.000Z') });
    expect(s.phase).toBe('plan_required');
  });

  it('lapsed entitlement with a stale paid attempt → plan_required (churned subscriber not trapped)', () => {
    const s = derive({
      entitlement: entitlement('canceled', { gracePeriodEndsAt: '2026-06-01T00:00:00.000Z' }),
      checkoutAttempt: attempt('paid', '2026-05-01T00:00:00.000Z'),
    });
    expect(s.phase).toBe('plan_required');
  });

  it('active entitlement, no machine → install choices required', () => {
    const s = derive({ entitlement: entitlement('active') });
    expect(s.phase).toBe('install_choices_required');
    expect(s.nextAction.kind).toBe('choose_default_installs');
    expect(s.progress).toBeUndefined();
  });

  it('grace-period entitlement still grants access', () => {
    const s = derive({ entitlement: entitlement('past_due', { gracePeriodEndsAt: '2026-06-12T00:00:00.000Z' }) });
    expect(s.phase).toBe('install_choices_required');
  });

  it('provisioning machine reports a stage derived from observable state', () => {
    expect(derive({ entitlement: entitlement('active'), liveMachine: machine('provisioning') }).progress?.stage).toBe('creating_server');
    expect(derive({ entitlement: entitlement('active'), liveMachine: machine('provisioning', { hetznerServerId: 1 }) }).progress?.stage).toBe('booting');
    expect(derive({ entitlement: entitlement('active'), liveMachine: machine('provisioning', { hetznerServerId: 1, publicIPv4: '203.0.113.4' }) }).progress?.stage).toBe('registering');
    expect(derive({ entitlement: entitlement('active'), liveMachine: machine('recovering', { hetznerServerId: 1 }) }).progress?.stage).toBe('finalizing');
  });

  it('failed machine under cap → provisioning_failed retryable', () => {
    const s = derive({ entitlement: entitlement('active'), liveMachine: machine('failed', { attempt: 2 }) });
    expect(s.phase).toBe('provisioning_failed');
    expect(s.failure).toEqual({ retryable: true, attempt: 2 });
    expect(s.nextAction.kind).toBe('retry_provision');
  });

  it('failed machine at cap → provisioning_failed not retryable, contact_support', () => {
    const s = derive({ entitlement: entitlement('active'), liveMachine: machine('failed', { attempt: 3 }) });
    expect(s.phase).toBe('provisioning_failed');
    expect(s.failure?.retryable).toBe(false);
    expect(s.nextAction.kind).toBe('contact_support');
  });

  it('running machine without first-run → first_run', () => {
    const s = derive({ entitlement: entitlement('active'), liveMachine: machine('running', { hetznerServerId: 1, publicIPv4: '203.0.113.4' }) });
    expect(s.phase).toBe('first_run');
    expect(s.nextAction.kind).toBe('begin_first_run');
  });

  it('running machine with first-run → ready (readiness omitted when not supplied)', () => {
    const s = derive({
      entitlement: entitlement('active'),
      liveMachine: machine('running', { hetznerServerId: 1, publicIPv4: '203.0.113.4' }),
      firstRun: { clerkUserId: 'user_123', completedAt: '2026-06-11T11:00:00.000Z', goal: 'coding', steps: {}, source: 'gateway_ws' },
    });
    expect(s.phase).toBe('ready');
    expect(s.nextAction.kind).toBe('open_shell');
    expect(s.readiness).toBeUndefined();
  });

  it('ready carries a supplied readiness annotation', () => {
    const s = derive({
      entitlement: entitlement('active'),
      liveMachine: machine('running', { hetznerServerId: 1, publicIPv4: '203.0.113.4' }),
      firstRun: { clerkUserId: 'user_123', completedAt: '2026-06-11T11:00:00.000Z', goal: null, steps: {}, source: 'gateway_ws' },
      readiness: { status: 'degraded', failing: ['terminal.ready'] },
    });
    expect(s.readiness).toEqual({ status: 'degraded', failing: ['terminal.ready'] });
  });
});

describe('platform/journey loadJourney', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('derives plan_required for an unknown user and records one transition event', async () => {
    const state = await loadJourney('user_new', { db, now: () => NOW, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN });
    expect(state.phase).toBe('plan_required');
    const ev = await getLatestJourneyEvent(db, 'user_new');
    expect(ev?.toPhase).toBe('plan_required');
    expect(ev?.fromPhase).toBeNull();
  });

  it('does not append a duplicate event when the phase is unchanged', async () => {
    await loadJourney('user_dup', { db, now: () => NOW, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN });
    await loadJourney('user_dup', { db, now: () => NOW, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN });
    const rows = await db.executor
      .selectFrom('onboarding_journey_events')
      .selectAll()
      .where('clerk_user_id', '=', 'user_dup')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('reads a seeded open checkout attempt as payment_settling', async () => {
    await insertCheckoutAttempt(db, {
      id: 'att-1', clerkUserId: 'user_pay', stripeSessionId: 'cs_live_1', createdAt: '2026-06-11T11:57:00.000Z',
    });
    const state = await loadJourney('user_pay', { db, now: () => NOW, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN });
    expect(state.phase).toBe('payment_settling');
  });

  it('keeps a paid attempt sticky even when a newer open attempt exists past the window', async () => {
    // User paid (old attempt), then opened a second checkout that has aged past
    // the window. The paid attempt must win → still settling, never plan_required.
    await insertCheckoutAttempt(db, { id: 'paid-1', clerkUserId: 'user_two', stripeSessionId: 'cs_paid', createdAt: '2026-06-11T11:40:00.000Z' });
    await resolveCheckoutAttempt(db, 'cs_paid', 'paid', '2026-06-11T11:41:00.000Z');
    await insertCheckoutAttempt(db, { id: 'open-2', clerkUserId: 'user_two', stripeSessionId: 'cs_open_new', createdAt: '2026-06-11T11:45:00.000Z' });
    const state = await loadJourney('user_two', { db, now: () => NOW, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN });
    expect(state.phase).toBe('payment_settling');
  });

  it('upserts and reads a first-run record (write-behind wins)', async () => {
    await insertUserMachine(db, {
      machineId: 'mm', clerkUserId: 'user_run', handle: 'runner', status: 'running',
      hetznerServerId: 5, publicIPv4: '203.0.113.9', provisionedAt: '2026-06-11T10:00:00.000Z',
    });
    await upsertOnboardingFirstRun(db, { clerkUserId: 'user_run', completedAt: '2026-06-11T11:00:00.000Z', goal: 'coding', source: 'gateway_ws' });
    // Entitlement is absent, so without access the phase is plan_required regardless of the machine.
    const state = await loadJourney('user_run', { db, now: () => NOW, maxProvisionAttempts: 3, appOrigin: APP_ORIGIN });
    expect(state.phase).toBe('plan_required');
  });
});

describe('platform/journey backfillFirstRunRecords', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('fills missing records for running machines whose probe reports completion', async () => {
    await insertUserMachine(db, { machineId: 'm-done', clerkUserId: 'user_done', handle: 'done', status: 'running', hetznerServerId: 1, publicIPv4: '203.0.113.1', provisionedAt: '2026-06-11T10:00:00.000Z' });
    await insertUserMachine(db, { machineId: 'm-no', clerkUserId: 'user_no', handle: 'no', status: 'running', hetznerServerId: 2, publicIPv4: '203.0.113.2', provisionedAt: '2026-06-11T10:00:00.000Z' });
    await insertUserMachine(db, { machineId: 'm-down', clerkUserId: 'user_down', handle: 'down', status: 'running', hetznerServerId: 3, publicIPv4: '203.0.113.3', provisionedAt: '2026-06-11T10:00:00.000Z' });

    const result = await backfillFirstRunRecords(db, {
      probe: async (machine) => {
        if (machine.handle === 'done') return { completedAt: '2026-06-10T00:00:00.000Z', goal: 'coding' };
        if (machine.handle === 'down') throw new Error('unreachable');
        return null; // user_no: not completed
      },
    });

    expect(result.checked).toBe(3);
    expect(result.filled).toBe(1);
    expect((await getOnboardingFirstRun(db, 'user_done'))?.source).toBe('backfill');
    expect(await getOnboardingFirstRun(db, 'user_no')).toBeUndefined();
    expect(await getOnboardingFirstRun(db, 'user_down')).toBeUndefined();
  });

  it('never overwrites an authoritative write-behind record', async () => {
    await insertUserMachine(db, { machineId: 'm1', clerkUserId: 'user_x', handle: 'x', status: 'running', hetznerServerId: 1, publicIPv4: '203.0.113.1', provisionedAt: '2026-06-11T10:00:00.000Z' });
    await upsertOnboardingFirstRun(db, { clerkUserId: 'user_x', completedAt: '2026-06-09T00:00:00.000Z', goal: 'company_brain', source: 'gateway_ws' });
    // The machine now has a record, so it is not even a candidate.
    const result = await backfillFirstRunRecords(db, { probe: async () => ({ completedAt: '2099-01-01T00:00:00.000Z', goal: 'coding' }) });
    expect(result.checked).toBe(0);
    const row = await getOnboardingFirstRun(db, 'user_x');
    expect(row?.goal).toBe('company_brain');
    expect(row?.source).toBe('gateway_ws');
  });
});
