import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createAccountDeletionBillingWebhookGuard } from '../../packages/platform/src/account-deletion/billing-webhook-guard.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { projectAccountDeletionBillingCancellation } from '../../packages/platform/src/account-deletion/billing-projection.js';
import { getBillingEntitlement, getBillingSubscriptionByStripeId, upsertBillingEntitlement, upsertBillingSubscription, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { getRuntimeEntitlementDecisionForUser } from '../../packages/platform/src/runtime-entitlement.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const owner = 'user_cancellation_projection';
const secret = 'billing-projection-secret-at-least-32';
const at = '2026-10-05T12:00:00.000Z';
const env = { ACCOUNT_DELETION_SECRET: secret, MATRIX_BILLING_PROVIDER: 'stripe' };
describe('account deletion billing terminal projection', () => {
  let db: PlatformDB;
  let repo: AccountDeletionRepository;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    repo = new AccountDeletionRepository(db.kysely, { secret, now: () => new Date(at) });
  });
  afterEach(async () => { vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });
  const seed = async () => {
    await upsertBillingSubscription(db, { clerkUserId: owner, stripeSubscriptionId: 'sub_cancel', stripeCustomerId: 'cus_cancel', runtimeSlot: 'primary', planSlug: 'matrix_starter', stripePriceId: 'price_cancel', billingInterval: 'monthly', status: 'active', currentPeriodEnd: null, gracePeriodEndsAt: '2099-01-01T00:00:00.000Z', latestEventCreatedAt: at, latestEventId: 'evt_before', updatedAt: at });
    await upsertBillingEntitlement(db, { clerkUserId: owner, source: 'stripe', planSlug: 'matrix_starter', status: 'active', maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0, defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'], stripeSubscriptionId: 'sub_cancel', stripePriceId: 'price_cancel', gracePeriodEndsAt: '2099-01-01T00:00:00.000Z', effectiveFrom: at, effectiveUntil: null, updatedAt: at });
  };
  it('keeps canceled billing terminal after deletion cancellation while deriving temporary access only from the deletion job', async () => {
    await seed(); await insertUserMachine(db, { machineId: 'projection-existing', clerkUserId: owner, handle: 'projectionexisting', status: 'running', runtimeSlot: 'primary', provisionedAt: '2026-10-04T12:00:00.000Z' });
    await repo.accept({ clerkUserId: owner, appleTokens: [] }, false);
    await projectAccountDeletionBillingCancellation(db, { clerkUserId: owner, stripeSubscriptionId: 'sub_cancel', stripeCustomerId: 'cus_cancel', at }, env);
    expect(await getBillingSubscriptionByStripeId(db, 'sub_cancel')).toMatchObject({ status: 'canceled', gracePeriodEndsAt: null });
    expect(await getBillingEntitlement(db, owner)).toMatchObject({ status: 'canceled', gracePeriodEndsAt: null, effectiveUntil: at });
    expect(await getRuntimeEntitlementDecisionForUser(db, owner, env, 'primary', 'customer', new Date(at))).toMatchObject({ runtimeProxyAllowed: true });
    await db.executor.updateTable('account_deletion_jobs').set({ billing_stopped: true }).execute();
    await repo.cancel(owner);
    expect(await upsertBillingSubscription(db, { clerkUserId: owner, stripeSubscriptionId: 'sub_cancel', stripeCustomerId: 'cus_cancel', runtimeSlot: 'primary', planSlug: 'matrix_starter', stripePriceId: 'price_cancel', billingInterval: 'monthly', status: 'active', currentPeriodEnd: null, gracePeriodEndsAt: null, latestEventCreatedAt: at, latestEventId: 'evt_delayed', updatedAt: at })).toBe(false);
    expect(await getRuntimeEntitlementDecisionForUser(db, owner, env, 'primary', 'customer', new Date(at))).toMatchObject({ runtimeProxyAllowed: false });
  });
  it('never restores rows for an erased owner and refuses an inconsistent customer mapping atomically', async () => {
    await seed(); await repo.accept({ clerkUserId: owner, appleTokens: [] }, false);
    await expect(projectAccountDeletionBillingCancellation(db, { clerkUserId: owner, stripeSubscriptionId: 'sub_cancel', stripeCustomerId: 'cus_other', at }, env)).rejects.toThrow();
    expect(await getBillingEntitlement(db, owner)).toMatchObject({ status: 'active' });
    await db.executor.deleteFrom('billing_subscriptions').execute(); await db.executor.deleteFrom('billing_entitlements').execute();
    await projectAccountDeletionBillingCancellation(db, { clerkUserId: owner, stripeSubscriptionId: 'sub_cancel', stripeCustomerId: 'cus_cancel', at }, env);
    expect(await getBillingSubscriptionByStripeId(db, 'sub_cancel')).toBeUndefined(); expect(await getBillingEntitlement(db, owner)).toBeUndefined();
  });
  it('records terminal webhook cancellation before the owner cancels deletion', async () => {
    await seed(); await repo.accept({ clerkUserId: owner, appleTokens: [] }, false);
    const app = new Hono();
    app.use('*', createAccountDeletionBillingWebhookGuard({ db, env: { ...env, STRIPE_SECRET_KEY: 'test', STRIPE_WEBHOOK_SECRET: 'test' },
      stripe: { constructWebhookEvent: () => ({ id: 'evt_terminal', type: 'customer.subscription.deleted', created: 1,
        data: { object: { id: 'sub_cancel', customer: 'cus_cancel', metadata: { clerk_user_id: owner } } } }) },
      request: vi.fn(async () => new Response(JSON.stringify({ id: 'sub_cancel', customer: 'cus_cancel', status: 'canceled' }))) }));
    app.post('/', c => c.json({ projected: true }));
    expect((await app.request('/', { method: 'POST', headers: { 'stripe-signature': 'verified' }, body: '{}' })).status).toBe(200);
    await db.executor.updateTable('account_deletion_jobs').set({ billing_stopped: true }).execute(); await repo.cancel(owner);
    expect(await getBillingSubscriptionByStripeId(db, 'sub_cancel')).toMatchObject({ status: 'canceled', gracePeriodEndsAt: null });
    expect(await getBillingEntitlement(db, owner)).toMatchObject({ status: 'canceled', gracePeriodEndsAt: null });
  });
});
