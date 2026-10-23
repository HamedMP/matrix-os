import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createStripeBillingClient } from '../../packages/platform/src/stripe-billing.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

// Only external Checkout creation is synthetic. Signature verification uses the
// real production Stripe adapter/SDK and every credit write uses the real DB.
// These are local signed fixtures, not evidence of Stripe-hosted event delivery.
const signingSecret = 'whsec_local_disposable_payment_acceptance';
const identity = { ownerId: 'user_signed_fixture', machineId: 'machine_signed_fixture', runtimeSlot: 'primary' } as const;
const requestId = '77f105df-6e24-4e13-a881-af9ce20d6a63';
const env = {
  MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_local_no_network', STRIPE_WEBHOOK_SECRET: signingSecret,
  STRIPE_PRICE_AI_CREDIT_USD_5: 'price_signed_5',
  STRIPE_PRICE_AI_CREDIT_USD_10: 'price_signed_10',
  STRIPE_PRICE_AI_CREDIT_USD_25: 'price_signed_25',
};

describe('real SDK signed AI credit payment receipts', () => {
  let db: PlatformDB;
  let app: Hono;
  let repository: ReturnType<typeof createAiFundedPolicyRepository>;
  const now = () => new Date();

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: 'signed-fixture', runtimeSlot: identity.runtimeSlot, status: 'running',
      imageVersion: 'test-only', provisionedAt: now().toISOString(), activationState: 'authorized' });
    repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now });
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: ['anthropic/claude-sonnet-5'], monthlyBudgetMicrousd: 0,
      budgetMode: 'credit_backed', expiresAt: null });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true,
      allowedModelIds: ['anthropic/claude-sonnet-5'] });
    const stripe: StripeBillingClient = {
      ...createStripeBillingClient({ secretKey: env.STRIPE_SECRET_KEY }),
      createAiCreditCheckoutSession: vi.fn(async () => ({ id: 'cs_signed_5',
        url: 'https://checkout.stripe.com/c/pay/cs_test_signed_fixture' })),
    };
    app = new Hono().route('/billing', createBillingRoutes({ db, stripe, env, now,
      resolveClerkUserId: async () => identity.ownerId, fundedAiRepository: repository,
      fundedModelProbes: { probe: async () => ({ ready: true, checkedAt: now().toISOString(),
        staleAfter: new Date(Date.now() + 30_000).toISOString() }) } }));
    const checkout = await app.request('/billing/ai-credit/checkout', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packageId: 'usd_5', runtimeSlot: identity.runtimeSlot, requestId }) });
    expect(checkout.status).toBe(200);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function event(type = 'checkout.session.completed', patch: Record<string, unknown> = {}) {
    return { id: `evt_${randomUUID()}`, object: 'event', livemode: false,
      type, created: Math.floor(Date.now() / 1000), data: { object: {
        id: 'cs_signed_5', object: 'checkout.session', livemode: false, mode: 'payment',
        status: 'complete', payment_status: 'paid', payment_intent: 'pi_signed_5',
        amount_subtotal: 500, amount_total: 500, currency: 'usd', client_reference_id: identity.ownerId,
        metadata: { matrix_checkout_kind: 'ai_credit_addon', matrix_owner_id: identity.ownerId,
          matrix_machine_id: identity.machineId, matrix_runtime_slot: identity.runtimeSlot,
          matrix_ai_credit_package_id: 'usd_5', matrix_ai_credit_request_id: requestId,
          matrix_ai_credit_price_id: 'price_signed_5', matrix_ai_credit_microusd: '5000000' },
        ...patch,
      } } };
  }
  function deliver(value: unknown, options: { secret?: string; timestamp?: number; tamper?: boolean } = {}) {
    const payload = JSON.stringify(value);
    const header = Stripe.webhooks.generateTestHeaderString({ payload,
      secret: options.secret ?? signingSecret, timestamp: options.timestamp ?? Math.floor(Date.now() / 1000) });
    return app.request('/billing/webhooks/stripe', { method: 'POST',
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      body: options.tamper ? payload.replace('5000000', '9000000') : payload });
  }
  async function assertBalance(amount: number) {
    expect(await repository.getFundingSummary(identity)).toMatchObject({
      addonBalanceMicrousd: amount, creditBalanceMicrousd: amount, monthlyBudgetMicrousd: amount,
    });
  }

  it.each([
    ['wrong secret', { secret: 'whsec_different_fixture' }],
    ['modified body', { tamper: true }],
    ['expired signature', { timestamp: Math.floor(Date.now() / 1000) - 600 }],
  ])('rejects %s before recording a receipt or credit', async (_label, options) => {
    expect((await deliver(event(), options)).status).toBe(400);
    await assertBalance(0);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom('billing_webhook_events').selectAll().execute()).toEqual([]);
  });

  it('grants the paid amount once across concurrent signed event retries and aligns its budget', async () => {
    const paid = event();
    const responses = await Promise.all([deliver(paid), deliver(paid), deliver({ ...paid, id: `evt_${randomUUID()}` })]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    await assertBalance(5_000_000);
    const ledger = await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ entry_id: 'addon:cs_signed_5', kind: 'addon_grant', amount_microusd: 5_000_000 });
  });

  it('waits for a signed asynchronous success before funding an unpaid session', async () => {
    expect((await deliver(event('checkout.session.completed', { payment_status: 'unpaid' }))).status).toBe(200);
    await assertBalance(0);
    expect((await deliver(event('checkout.session.async_payment_succeeded'))).status).toBe(200);
    await assertBalance(5_000_000);
  });

  it('reverses a locally signed refund once and restores the credit-backed cap', async () => {
    expect((await deliver(event())).status).toBe(200);
    const refund = { id: `evt_${randomUUID()}`, type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000), data: { object: { id: 'ch_signed_5',
        payment_intent: 'pi_signed_5', amount_refunded: 500, currency: 'usd' } } };
    expect((await deliver(refund)).status).toBe(200);
    expect((await deliver({ ...refund, id: `evt_${randomUUID()}` })).status).toBe(200);
    await assertBalance(0);
    const claim = await db.executor.selectFrom('ai_credit_checkout_claims')
      .select(['granted_microusd', 'reversed_microusd']).executeTakeFirstOrThrow();
    expect(claim).toEqual({ granted_microusd: 5_000_000, reversed_microusd: 5_000_000 });
  });

  it('keeps an explicit fixed operator ceiling while adding purchased credit', async () => {
    await repository.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true,
      allowedModelIds: ['anthropic/claude-sonnet-5'], monthlyBudgetMicrousd: 1_000_000,
      budgetMode: 'fixed', expiresAt: null });
    expect((await deliver(event())).status).toBe(200);
    expect(await repository.getFundingSummary(identity)).toMatchObject({
      addonBalanceMicrousd: 5_000_000, creditBalanceMicrousd: 5_000_000, monthlyBudgetMicrousd: 1_000_000,
    });
  });
});
