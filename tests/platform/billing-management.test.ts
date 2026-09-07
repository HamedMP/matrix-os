import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixBillingStatusSchema } from '@matrix-os/contracts';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import { insertUserMachine, upsertBillingCustomer, upsertBillingOverride, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const at = '2026-09-07T00:00:00.000Z';
describe('billing management is independent of runtime access', () => {
  let db: PlatformDB;
  const retrieveRecurringPrice = vi.fn();
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    retrieveRecurringPrice.mockReset();
    await upsertBillingOverride(db, {
      id: 'team-access', clerkUserId: 'owner', planSlug: 'internal', status: 'active',
      maxRuntimeSlots: 3, includedRuntimeSlots: 3, addonRuntimeSlots: 0,
      defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'],
      reason: 'Team access', createdBy: 'test', createdAt: at, expiresAt: null, revokedAt: null,
    });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  function app(owner: string | null = 'owner') {
    return new Hono().route('/billing', createBillingRoutes({
      db, stripe: { apiTimeoutMs: 10000, retrieveRecurringPrice } as unknown as StripeBillingClient,
      env: {}, resolveClerkUserId: async () => owner, now: () => new Date(at),
    }));
  }
  async function subscribe(runtimeSlot = 'primary', owner = 'owner') {
    await upsertBillingCustomer(db, { clerkUserId: owner, stripeCustomerId: `cus_${owner}`, createdAt: at, updatedAt: at });
    await upsertBillingSubscription(db, {
      clerkUserId: owner, runtimeSlot, stripeCustomerId: `cus_${owner}`, stripeSubscriptionId: `sub_${owner}_${runtimeSlot}`,
      planSlug: 'matrix_builder', stripePriceId: 'price_builder', billingInterval: 'annual',
      priceUnitAmountMinor: 99000, priceCurrency: 'usd', priceIntervalCount: 1, priceQuantity: 1,
      status: 'active', currentPeriodEnd: '2027-09-07T00:00:00.000Z', gracePeriodEndsAt: null,
      latestEventCreatedAt: at, latestEventId: 'evt_paid', updatedAt: at,
    });
  }
  it('keeps the legacy response unchanged for strict installed clients', async () => {
    await subscribe();
    const body = await (await app().request('/billing/status')).json();
    expect(MatrixBillingStatusSchema.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty('management');
    expect(body.entitlement).toMatchObject({ source: 'override', planSlug: 'internal', billingInterval: null });
  });
  it('reports the paid subscription under an internal override', async () => {
    await subscribe();
    const response = await app().request('/billing/status?details=management');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entitlement).toMatchObject({ source: 'override', maxRuntimeSlots: 3 });
    expect(body.management).toMatchObject({
      portalAvailable: true, runtimeSlot: 'primary', computerCount: 0, runtimePlacement: null,
      subscription: { planSlug: 'matrix_builder', status: 'active', billingInterval: 'annual', recurringPrice: { unitAmountMinor: 99000 } },
    });
    expect(body.access.runtimeProxyAllowed).toBe(true);
    expect(JSON.stringify(body.management)).not.toMatch(/cus_owner|sub_owner|price_builder/);
  });
  it('reports internal access without inventing a subscription', async () => {
    const body = await (await app().request('/billing/status?details=management')).json();
    expect(body.management).toMatchObject({ subscription: null, portalAvailable: false, computerCount: 0 });
    expect(retrieveRecurringPrice).not.toHaveBeenCalled();
  });
  it('retains account portal eligibility without an entitlement', async () => {
    await upsertBillingCustomer(db, { clerkUserId: 'customer', stripeCustomerId: 'cus_customer', createdAt: at, updatedAt: at });
    const body = await (await app('customer').request('/billing/status?details=management')).json();
    expect(body.entitlement).toBeNull();
    expect(body.management).toMatchObject({ subscription: null, portalAvailable: true });
  });
  it('does not borrow a subscription from a different owner or slot', async () => {
    await subscribe('studio');
    await subscribe('primary', 'other');
    const body = await (await app().request('/billing/status?details=management')).json();
    expect(body.management?.subscription).toBeNull();
    const studio = await (await app().request('/billing/status?details=management&runtimeSlot=studio')).json();
    expect(studio.management?.subscription?.planSlug).toBe('matrix_builder');
  });
  it('counts only owner machines that are not deleted and reports selected placement', async () => {
    for (const [machineId, owner, slot, deletedAt] of [
      ['primary', 'owner', 'primary', null], ['studio', 'owner', 'studio', null],
      ['deleted', 'owner', 'archive', at], ['other', 'other', 'primary', null],
    ] as const) {
      await insertUserMachine(db, {
        machineId, clerkUserId: owner, handle: `machine-${machineId}`, runtimeSlot: slot,
        hetznerServerId: null, publicIPv4: null, status: 'running', imageVersion: 'test', provisionedAt: at,
        serverType: 'cpx22', location: 'ash', deletedAt,
      });
    }
    const body = await (await app().request('/billing/status?details=management')).json();
    expect(body.management).toMatchObject({ computerCount: 2, runtimePlacement: { regionSlug: 'region_ash' } });
  });
  it('requires authentication and validates management queries', async () => {
    expect((await app(null).request('/billing/status?details=management')).status).toBe(401);
    expect((await app().request('/billing/status?details=secrets')).status).toBe(400);
  });
});
