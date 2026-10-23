import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { loadAiCreditCheckoutConfig } from '../../packages/platform/src/ai-credit-checkout.js';
import { createAiCreditCheckoutHandler } from '../../packages/platform/src/billing/ai-credit-checkout-route.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createAiFundedRuntimeRoutes } from '../../packages/platform/src/ai-funded-policy-routes.js';
import { buildPlatformRuntimeVerificationToken } from '../../packages/platform/src/platform-token.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const main = '00000000-0000-4000-8000-000000000001';
const sibling = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const env = { MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'fixture', STRIPE_WEBHOOK_SECRET: 'fixture',
  STRIPE_PRICE_AI_CREDIT_USD_5: 'price_fixture_5', STRIPE_PRICE_AI_CREDIT_USD_10: 'price_fixture_10', STRIPE_PRICE_AI_CREDIT_USD_25: 'price_fixture_25' };

describe('machine-scoped purchase configuration', () => {
  it.each(['[]', 'invalid json', '["not-a-uuid"]', JSON.stringify(Array(33).fill(main))])('fails closed for invalid configured list %s', value => {
    expect(loadAiCreditCheckoutConfig({ ...env, MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS: value }).enabled).toBe(false);
  });
});

describe('machine-scoped checkout admission', () => {
  let db: PlatformDB;
  const model = '@cf/zai-org/glm-5.3-flash';
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  async function app() {
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32) });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    for (const [machineId, ownerId, runtimeSlot] of [[main, 'owner', 'primary'], [sibling, 'owner', 'second'], [other, 'other', 'primary']]) {
      await insertUserMachine(db, { machineId, clerkUserId: ownerId, runtimeSlot, handle: `qa-${machineId.slice(-2)}`, status: 'running', imageVersion: 'fixture', activationState: 'authorized', provisionedAt: new Date().toISOString() });
      await repository.setRuntimePolicy({ identity: { machineId, ownerId, runtimeSlot }, expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 100000, expiresAt: null });
      await repository.grantCredit({ identity: { machineId, ownerId, runtimeSlot }, entryId: `grant-${machineId}`, kind: 'addon_grant', amountMicrousd: 100000, sourceReference: 'fixture' });
    }
    const config = loadAiCreditCheckoutConfig({ ...env, MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS: JSON.stringify([main]) });
    const a = new Hono();
    a.post('/checkout', createAiCreditCheckoutHandler({ db, checkout: config, env: {}, now: () => new Date(),
      resolveClerkUserId: async c => c.req.header('x-fixture-owner') ?? 'owner', fundedAiRepository: repository,
      fundedModelProbes: { probe: async () => ({ ready: true, checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60000).toISOString() }) },
      stripe: { apiTimeoutMs: 1000, createAiCreditCheckoutSession: async input => ({ id: `cs_fixture_${input.requestId.replaceAll('-', '')}`, url: 'https://checkout.stripe.com/c/pay/fixture' }) } as never,
      unavailableResponse: { code: 'billing_unavailable', error: 'Unavailable' } }));
    return { a, repository };
  }
  it('permits the configured main while denying the same owner sibling and another owner before creating a checkout', async () => {
    const { a } = await app();
    const request = (runtimeSlot: string, owner = 'owner') => a.request('/checkout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-owner': owner }, body: JSON.stringify({ runtimeSlot, packageId: 'usd_5', requestId: randomUUID() }) });
    expect((await request('second')).status).toBe(503);
    expect((await request('primary', 'other')).status).toBe(503);
    expect(await db.executor.selectFrom('ai_credit_checkout_claims').selectAll().execute()).toEqual([]);
    expect((await request('primary')).status).toBe(200);
    expect(await db.executor.selectFrom('ai_credit_checkout_claims').select(['machine_id']).execute()).toEqual([{ machine_id: main }]);
  });
  it('advertises top-up only to the authenticated configured computer', async () => {
    const { repository } = await app();
    const platformSecret = 'p'.repeat(32);
    const a = new Hono().route('/internal/containers/:handle/ai', createAiFundedRuntimeRoutes({ db, repository,
      platformSecret, topUpEnabled: true, topUpAllowedMachineIds: [main] }));
    for (const [machineId, handle, runtimeSlot, want] of [[main, 'qa-01', 'primary', true], [sibling, 'qa-02', 'second', false], [other, 'qa-03', 'primary', false]] as const) {
      const token = buildPlatformRuntimeVerificationToken({ machineId, handle, runtimeSlot }, platformSecret);
      const response = await a.request(`/internal/containers/${handle}/ai/funding-summary?runtimeSlot=${runtimeSlot}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(200);
      expect((await response.json()).funding.topUpEnabled).toBe(want);
    }
  });
});
