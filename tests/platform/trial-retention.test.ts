import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, upsertBillingCustomer, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { listExpiredTrialMachines, prepareExpiredTrialCleanup } from '../../packages/platform/src/trial-retention.js';

const ownerId = 'user_retention';
const machineId = '5b8d4091-4b05-4aae-94ba-928900fa32a0';
const trialEndsAt = '2026-10-01T00:00:00.000Z';
const now = () => new Date('2026-10-18T00:00:00.000Z');
const target = { ownerId, machineId, serverId: 12345, subscriptionId: 'sub_trial',
  noticeGivenAt: '2026-10-09T00:00:00.000Z', noticeReference: 'support:notice-123' };
const sourceSha = 'a'.repeat(40);
const review = { version: 1, sourceSha, authorizationReference: 'review:cleanup-123',
  issuedAt: '2026-10-17T23:59:00.000Z', expiresAt: '2026-10-18T00:04:00.000Z', targets: [target] };

describe('reviewed expired trial cleanup', () => {
  let db: PlatformDB;
  const verifyProvider = vi.fn();
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle: 'trial-example', runtimeSlot: 'primary',
      provisioningClass: 'customer', hetznerServerId: 12345, status: 'suspended',
      provisionedAt: '2026-09-24T00:00:00.000Z' });
    await upsertBillingCustomer(db, { clerkUserId: ownerId, stripeCustomerId: 'cus_trial',
      createdAt: trialEndsAt, updatedAt: trialEndsAt });
    await upsertBillingSubscription(db, { clerkUserId: ownerId, stripeSubscriptionId: 'sub_trial', stripeCustomerId: 'cus_trial',
      runtimeSlot: 'primary', planSlug: 'matrix_starter', stripePriceId: 'price_trial', billingInterval: 'monthly',
      status: 'canceled', currentPeriodEnd: trialEndsAt, gracePeriodEndsAt: null,
      trialStartedAt: '2026-09-24T00:00:00.000Z', trialEndsAt, trialConvertedAt: null,
      latestEventCreatedAt: trialEndsAt, latestEventId: 'evt_canceled', updatedAt: trialEndsAt });
    verifyProvider.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => destroyTestPlatformDb(db));

  const prepare = (input: unknown = review, mode = {}) => prepareExpiredTrialCleanup({ db, now, verifyProvider, sourceSha,
    env: { MATRIX_TRIAL_RETENTION_DEPLOYED_SOURCE_SHA: sourceSha } }, input, mode);
  const machine = () => db.executor.selectFrom('user_machines').selectAll().where('machine_id', '=', machineId).executeTakeFirstOrThrow();
  const queue = () => db.executor.selectFrom('provider_deletion_queue').selectAll().execute();

  it('lists a bounded private candidate inventory without changing data', async () => {
    await expect(listExpiredTrialMachines(db, now(), 10)).resolves.toMatchObject([{ machineId, serverId: 12345,
      subscriptionId: 'sub_trial', trialEndsAt, earliestDeleteAt: '2026-10-08T00:00:00.000Z' }]);
    expect((await machine()).deleted_at).toBeNull();
    expect(await queue()).toEqual([]);
  });

  it('dry-runs exact identities and prior-notice attestation, then atomically queues their deletion', async () => {
    const dryRun = await prepare();
    expect(dryRun).toMatchObject({ mode: 'dry-run', targetCount: 1 });
    expect(await queue()).toEqual([]);
    expect((await machine()).status).toBe('suspended');
    expect(verifyProvider).toHaveBeenCalledWith(expect.objectContaining({ ...target, customerId: 'cus_trial', trialEndsAt }));
    const applied = await prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint });
    expect(applied).toMatchObject({ mode: 'queued', targetCount: 1, fingerprint: dryRun.fingerprint });
    expect(await machine()).toMatchObject({ status: 'deleted', deleted_at: expect.any(String) });
    expect(await queue()).toMatchObject([{ provider_server_id: 12345, machine_id: machineId,
      reason: 'expired_trial', completed_at: null, last_error: null }]);
    expect(await db.executor.selectFrom('billing_customers').selectAll().execute()).toHaveLength(1);
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
  });

  it.each([
    { name: 'paid conversion', changes: { trial_converted_at: '2026-10-02T00:00:00.000Z' } },
    { name: 'active recovery', changes: { status: 'active' } },
    { name: 'unpaid recoverable subscription', changes: { status: 'unpaid' } },
    { name: 'extended trial', changes: { trial_ends_at: '2026-10-17T00:00:00.000Z' } },
    { name: 'grace period', changes: { grace_period_ends_at: '2026-10-20T00:00:00.000Z' } },
  ])('refuses $name at apply after a dry run', async ({ changes }) => {
    const dryRun = await prepare();
    await db.executor.updateTable('billing_subscriptions').set(changes).where('stripe_subscription_id', '=', 'sub_trial').execute();
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    expect((await machine()).deleted_at).toBeNull(); expect(await queue()).toEqual([]);
  });

  it('refuses new paid history in another slot or an active override', async () => {
    const dryRun = await prepare();
    const original = await db.executor.selectFrom('billing_subscriptions').selectAll().executeTakeFirstOrThrow();
    await db.executor.insertInto('billing_subscriptions').values({ ...original, stripe_subscription_id: 'sub_paid',
      runtime_slot: 'extra', trial_converted_at: trialEndsAt }).execute();
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    expect(await queue()).toEqual([]);
  });

  it('refuses provider uncertainty and rolls back all intent writes', async () => {
    const dryRun = await prepare();
    verifyProvider.mockRejectedValue(new Error('provider check failed'));
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow();
    expect((await machine()).deleted_at).toBeNull(); expect(await queue()).toEqual([]);
  });

  it('rolls back the machine tombstone when inserting the durable provider intent fails', async () => {
    const dryRun = await prepare();
    verifyProvider.mockImplementationOnce(async () => {
      await db.executor.insertInto('provider_deletion_queue').values({ id: 'conflicting-provider-intent', provider_server_id: 12345,
        machine_id: machineId, handle: 'trial-example', reason: 'delete', attempts: 0, next_attempt_at: now().toISOString(),
        created_at: now().toISOString(), last_error: null, completed_at: null }).execute();
    });
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow();
    expect((await machine()).deleted_at).toBeNull(); expect(await queue()).toEqual([]);
  });

  it('retains an owner who purchased AI credits, even without a converted subscription', async () => {
    const dryRun = await prepare();
    await db.executor.insertInto('ai_funded_credit_ledger').values({ entry_id: 'purchased-credits', owner_id: ownerId,
      machine_id: machineId, runtime_slot: 'primary', kind: 'addon_grant', amount_microusd: 5_000_000,
      source_reference: 'checkout:credits', reservation_id: null, period_start: null, expires_at: null,
      created_at: now().toISOString() }).execute();
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    expect(await queue()).toEqual([]);
  });

  it('invalidates review when the exact server or subscription event cursor changes', async () => {
    const dryRun = await prepare();
    await db.executor.updateTable('billing_subscriptions').set({ latest_event_id: 'evt_later' }).execute();
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    await expect(prepare({ ...review, targets: [{ ...target, serverId: 67890 }] })).rejects.toThrow(/refused/);
    expect(await queue()).toEqual([]);
  });

  it('requires a fresh review, at least seven days notice, and an explicit reviewed fingerprint to apply', async () => {
    await expect(prepare(review, { apply: true })).rejects.toThrow(/refused/);
    await expect(prepare({ ...review, expiresAt: '2026-10-17T23:59:59.000Z' })).rejects.toThrow(/refused/);
    await expect(prepare({ ...review, targets: [{ ...target, noticeGivenAt: '2026-10-17T00:00:00.000Z' }] })).rejects.toThrow(/refused/);
    await expect(prepare({ ...review, targets: [target, target] })).rejects.toThrow();
    await expect(prepare({ ...review, sourceSha: 'b'.repeat(40) })).rejects.toThrow(/refused/);
    expect(await queue()).toEqual([]);
  });

  it('refuses apply without explicit attestation that the reviewed lock implementation is deployed', async () => {
    const dryRun = await prepare();
    await expect(prepareExpiredTrialCleanup({ db, now, verifyProvider, sourceSha, env: {} }, review,
      { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    expect((await machine()).deleted_at).toBeNull(); expect(await queue()).toEqual([]);
  });

  it('refuses a purchase that is in flight before its subscription webhook arrives', async () => {
    const dryRun = await prepare();
    await db.executor.insertInto('billing_checkout_attempts').values({ id: 'attempt_pending', clerk_user_id: ownerId,
      runtime_slot: 'primary', stripe_session_id: 'cs_pending', checkout_url: null, plan_slug: 'matrix_starter',
      billing_interval: 'monthly', region_slug: null, server_type: null, trial_period_days: null, developer_tools: '[]',
      status: 'open', created_at: now().toISOString(), resolved_at: null }).execute();
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    expect(await queue()).toEqual([]);
  });

  it('refuses an active owner override even if there is no Stripe conversion', async () => {
    const dryRun = await prepare();
    await db.executor.insertInto('billing_entitlement_overrides').values({ id: 'override_internal', clerk_user_id: ownerId,
      plan_slug: 'internal', status: 'active', max_runtime_slots: 1, included_runtime_slots: 1, addon_runtime_slots: 0,
      default_server_type: 'cpx22', allowed_server_types: '["cpx22"]', reason: 'support', created_by: 'operator',
      expires_at: null, revoked_at: null, created_at: now().toISOString() }).execute();
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    expect(await queue()).toEqual([]);
  });

  it.each(['running', 'resizing', 'recovering', 'resuming'])('refuses %s machines', async status => {
    await db.executor.updateTable('user_machines').set({ status }).where('machine_id', '=', machineId).execute();
    await expect(prepare()).rejects.toThrow(/refused/);
    expect(await queue()).toEqual([]);
  });

  it('catches reflected recovery at final recheck even after the provider preflight', async () => {
    const dryRun = await prepare();
    verifyProvider.mockImplementationOnce(async () => {
      await db.executor.updateTable('billing_subscriptions').set({ trial_converted_at: now().toISOString() }).execute();
    });
    await expect(prepare(review, { apply: true, reviewedFingerprint: dryRun.fingerprint })).rejects.toThrow(/refused/);
    expect((await machine()).deleted_at).toBeNull(); expect(await queue()).toEqual([]);
  });
});
