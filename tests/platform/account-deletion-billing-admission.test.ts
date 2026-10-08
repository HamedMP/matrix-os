import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripeBillingClient } from '../../packages/platform/src/billing/stripe-client.js';
import { createAccountDeletionGuardedStripeClient } from '../../packages/platform/src/account-deletion/billing-admission.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { upsertBillingCustomer, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const secret = 'billing-admission-secret-at-least-32-bytes';
const owner = 'user_billing_deletion';
const env = { ACCOUNT_DELETION_SECRET: secret };
describe('account deletion outbound billing admission', () => {
  let db: PlatformDB;
  const client: StripeBillingClient = {
    apiTimeoutMs: 1000,
    createCheckoutSession: vi.fn(async () => ({ id: 'cs_new', url: 'https://billing.example/checkout' })),
    createAiCreditCheckoutSession: vi.fn(async () => ({ id: 'cs_credit', url: 'https://billing.example/credit' })),
    retrieveCheckoutSession: vi.fn(async () => ({ status: 'expired' as const, url: null, clerkUserId: null, priceId: null, regionSlug: null })),
    retrieveRecurringPrice: vi.fn(async () => ({ priceId: 'price_test', unitAmountMinor: 100, currency: 'usd', interval: 'monthly' as const, intervalCount: 1 })),
    createPortalSession: vi.fn(async () => ({ url: 'https://billing.example/portal' })),
    constructWebhookEvent: vi.fn(() => ({ id: 'evt_test', type: 'example', created: 1, data: { object: {} } })),
  };
  beforeEach(async () => { vi.clearAllMocks(); ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const subscription = { idempotencyKey: 'attempt', clerkUserId: owner, priceId: 'price_sub', mode: 'subscription' as const, automaticTax: false, allowPromotionCodes: false, regionSlug: 'region_fsn1', runtimeSlot: 'primary', redditAttributionExpiresAt: '2026-10-06T00:00:00.000Z', successUrl: 'https://app.example/success', cancelUrl: 'https://app.example/cancel' };
  const credit = { idempotencyKey: 'credit', requestId: 'request', clerkUserId: owner, machineId: 'machine', runtimeSlot: 'primary', packageId: 'usd_5', priceId: 'price_credit', amountMicrousd: 5000000, automaticTax: false, successUrl: 'https://app.example/success', cancelUrl: 'https://app.example/cancel' };
  it('refuses outbound Stripe creates and hosted portal access after deletion acceptance', async () => {
    vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    try { await upsertBillingCustomer(db, { clerkUserId: owner, stripeCustomerId: 'cus_owner', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
    finally { vi.unstubAllEnvs(); }
    await new AccountDeletionRepository(db.kysely, { secret }).accept({ clerkUserId: owner, appleTokens: [] }, false);
    const guarded = createAccountDeletionGuardedStripeClient(db, client, env);
    await expect(guarded.createCheckoutSession(subscription)).rejects.toThrow('Account deletion is pending');
    await expect(guarded.createAiCreditCheckoutSession(credit)).rejects.toThrow('Account deletion is pending');
    await expect(guarded.createPortalSession({ customerId: 'cus_owner', returnUrl: 'https://app.example' })).rejects.toThrow('Account deletion is pending');
    expect(client.createCheckoutSession).not.toHaveBeenCalled(); expect(client.createAiCreditCheckoutSession).not.toHaveBeenCalled(); expect(client.createPortalSession).not.toHaveBeenCalled();
  });
  it('preserves normal checkout and binds passthrough methods to the injected Stripe client', async () => {
    const guarded = createAccountDeletionGuardedStripeClient(db, client, env);
    expect(await guarded.createCheckoutSession(subscription)).toMatchObject({ id: 'cs_new' });
    expect(await guarded.createAiCreditCheckoutSession(credit)).toMatchObject({ id: 'cs_credit' });
    await guarded.retrieveCheckoutSession('cs_existing');
    expect(client.retrieveCheckoutSession).toHaveBeenCalledWith('cs_existing');
    expect(vi.mocked(client.retrieveCheckoutSession).mock.contexts[0]).toBe(client);
  });
});
