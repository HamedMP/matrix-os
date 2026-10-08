import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { getAccountDeletionAdmission, withAccountDeletionAdmission } from '../../packages/platform/src/account-deletion/admission.js';
import { getRuntimeEntitlementDecisionForUser } from '../../packages/platform/src/runtime-entitlement.js';
import { insertUserMachine, upsertBillingCustomer, upsertBillingSubscription, enqueueBillingRuntimeAction, claimCheckoutAttempt, type PlatformDB } from '../../packages/platform/src/db.js';
import { dispatchBillingRuntimeActions } from '../../packages/platform/src/billing-runtime-actions.js';
import { processAiCreditWebhookEvent } from '../../packages/platform/src/ai-credit-checkout-webhook.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const secret = 'admission-secret-with-at-least-32-bytes';
const owner = 'user_deletion_admission';
const clock = new Date('2026-10-05T12:00:00.000Z');
const env = { ACCOUNT_DELETION_SECRET: secret, MATRIX_BILLING_PROVIDER: 'stripe' };

describe('account deletion admission', () => {
  let db: PlatformDB;
  let repo: AccountDeletionRepository;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    repo = new AccountDeletionRepository(db.kysely, { secret, now: () => clock });
    vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });
  const schedule = async () => repo.accept({ clerkUserId: owner, appleTokens: [] }, false);

  it('permits normal work without a deletion job and blocks work for all active deletion phases', async () => {
    expect(await getAccountDeletionAdmission(db, owner, env, clock)).toMatchObject({ newWorkAllowed: true, runtimeAccess: 'normal' });
    await schedule();
    expect(await getAccountDeletionAdmission(db, owner, env, clock)).toMatchObject({ newWorkAllowed: false, runtimeAccess: 'grace' });
    const work = vi.fn(async () => 'created');
    for (const status of ['scheduled', 'processing', 'completed'] as const) {
      await db.executor.updateTable('account_deletion_jobs').set({ status }).execute();
      await expect(withAccountDeletionAdmission(db, owner, work, env)).rejects.toThrow('Account deletion is pending');
    }
    expect(work).not.toHaveBeenCalled();
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'cancelled' }).execute();
    expect(await withAccountDeletionAdmission(db, owner, work, env)).toBe('created');
  });

  it('ends runtime grace at the deadline even before the worker claims destruction', async () => {
    const job = await schedule();
    expect(await getAccountDeletionAdmission(db, owner, env, new Date(job.due_at))).toMatchObject({ runtimeAccess: 'blocked' });
  });

  it('preserves existing authorized runtime access after immediate Stripe cancellation but denies provisioning and expired grace', async () => {
    await insertUserMachine(db, { machineId: 'existing', clerkUserId: owner, handle: 'existing', status: 'running', runtimeSlot: 'primary', provisionedAt: '2026-10-04T12:00:00.000Z' });
    const job = await schedule();
    expect(await getRuntimeEntitlementDecisionForUser(db, owner, env, 'primary', 'customer', clock)).toMatchObject({ runtimeProxyAllowed: true });
    expect(await getRuntimeEntitlementDecisionForUser(db, owner, env, 'second', 'customer', clock)).toMatchObject({ runtimeProxyAllowed: false });
    expect(await getRuntimeEntitlementDecisionForUser(db, owner, env, 'primary', 'preview', new Date(job.due_at))).toMatchObject({ runtimeProxyAllowed: false });
  });

  it('ignores stale Stripe writes while deletion is active, including after PII rows were removed', async () => {
    await schedule();
    await upsertBillingCustomer(db, { clerkUserId: owner, stripeCustomerId: 'cus_stale', createdAt: clock.toISOString(), updatedAt: clock.toISOString() });
    expect(await db.executor.selectFrom('billing_customers').selectAll().execute()).toEqual([]);
    expect(await upsertBillingSubscription(db, { clerkUserId: owner, stripeCustomerId: 'cus_stale', stripeSubscriptionId: 'sub_stale', runtimeSlot: 'primary', planSlug: 'starter', stripePriceId: 'price_stale', billingInterval: 'monthly', status: 'active', currentPeriodEnd: null, gracePeriodEndsAt: null, latestEventCreatedAt: clock.toISOString(), latestEventId: 'evt_stale', updatedAt: clock.toISOString() })).toBe(false);
  });
  it('blocks checkout claims and billing suspensions during the export grace', async () => {
    await insertUserMachine(db, { machineId: 'existing', clerkUserId: owner, handle: 'existing', status: 'running', runtimeSlot: 'primary', provisionedAt: clock.toISOString() });
    await schedule();
    expect(await enqueueBillingRuntimeAction(db, { clerkUserId: owner, runtimeSlot: 'primary', stripeSubscriptionId: 'sub_cancelled', action: 'suspend', reason: 'trial_ended_unpaid', executeAfter: clock.toISOString(), createdAt: clock.toISOString() })).toBeUndefined();
    await expect(claimCheckoutAttempt(db, { id: 'checkout', clerkUserId: owner, runtimeSlot: 'primary', planSlug: 'starter', billingInterval: 'monthly', regionSlug: 'eu', createdAt: clock.toISOString() })).rejects.toThrow('Account deletion is pending');
    expect(await db.executor.selectFrom('billing_checkout_attempts').selectAll().execute()).toEqual([]);
  });

  it('blocks new funded AI reservations and credit grants while permitting settlement of existing requests', async () => {
    const identity = { ownerId: owner, machineId: 'funded', runtimeSlot: 'primary' };
    const modelId = 'anthropic/claude-sonnet-5';
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: owner, handle: 'funded', status: 'running', runtimeSlot: 'primary', activationState: 'authorized', provisionedAt: clock.toISOString() });
    const funded = createAiFundedPolicyRepository({ db, credentialHashSecret: secret, now: () => clock });
    await funded.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await funded.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 10000, expiresAt: null });
    await funded.grantCredit({ entryId: 'before', identity, kind: 'addon_grant', amountMicrousd: 10000, sourceReference: 'paid' });
    const credential = (await funded.issueRuntimeCredential(identity)).credential;
    const existing = await funded.authorize({ credential: credential.token, requestId: 'before', modelId, maxCostMicrousd: 100 });
    await funded.startReservation({ reservationId: existing.reservation.reservationId, tokenId: credential.tokenId });
    await schedule();
    await expect(funded.authorize({ credential: credential.token, requestId: 'after', modelId, maxCostMicrousd: 100 })).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(funded.grantCredit({ entryId: 'after', identity, kind: 'addon_grant', amountMicrousd: 10000, sourceReference: 'paid' })).rejects.toMatchObject({ code: 'access_disabled' });
    expect(await funded.settleReservation({ reservationId: existing.reservation.reservationId, tokenId: credential.tokenId, actualCostMicrousd: 60 })).toMatchObject({ actualCostMicrousd: 60 });
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute()).toHaveLength(1);
  });

  it('acknowledges a delayed signed AI credit checkout after owner rows have been erased without re-granting credit', async () => {
    await schedule();
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'completed' }).execute();
    const grantCreditInTransaction = vi.fn();
    const event = { id: 'evt_delayed', type: 'checkout.session.completed', created: 1, data: { object: { metadata: {
      matrix_checkout_kind: 'ai_credit_addon', matrix_owner_id: owner, matrix_machine_id: 'erased', matrix_runtime_slot: 'primary',
      matrix_ai_credit_package_id: 'usd_5', matrix_ai_credit_request_id: '11111111-1111-4111-8111-111111111111',
      matrix_ai_credit_price_id: 'price_credits', matrix_ai_credit_microusd: '5000000',
    } } } };
    expect(await db.transaction((trx) => processAiCreditWebhookEvent({ event, trx, repository: { grantCreditInTransaction }, at: clock.toISOString() }))).toEqual({ received: true, ignored: true });
    expect(grantCreditInTransaction).not.toHaveBeenCalled();
  });

  it('skips a suspension already queued before deletion acceptance so grace access stays available', async () => {
    await insertUserMachine(db, { machineId: 'queued', clerkUserId: owner, handle: 'queued', status: 'running', runtimeSlot: 'primary', provisionedAt: clock.toISOString() });
    await enqueueBillingRuntimeAction(db, { clerkUserId: owner, runtimeSlot: 'primary', stripeSubscriptionId: 'sub_prior', action: 'suspend', reason: 'trial_ended_unpaid', executeAfter: clock.toISOString(), createdAt: clock.toISOString() });
    await schedule();
    const suspendForBilling = vi.fn();
    await dispatchBillingRuntimeActions({ db, customerVpsService: { suspendForBilling, resumeForBilling: vi.fn() }, now: () => clock });
    expect(suspendForBilling).not.toHaveBeenCalled();
  });

});
