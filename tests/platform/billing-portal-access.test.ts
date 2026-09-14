import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import { upsertBillingCustomer, upsertBillingOverride, type PlatformDB } from '../../packages/platform/src/db.js';
import { MatrixBillingStatusSchema } from '@matrix-os/contracts';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const timestamp = '2026-09-01T00:00:00.000Z';
describe('account billing portal access', () => {
 let db: PlatformDB;
 const createPortalSession = vi.fn(async () => ({ url: 'https://billing.stripe.test/session' }));
 beforeEach(async () => { ({db} = await createTestPlatformDb()); createPortalSession.mockClear(); });
 afterEach(async () => { await destroyTestPlatformDb(db); });
 function app(userId: string | null = 'user_owner') {
  return new Hono().route('/billing', createBillingRoutes({
   db, stripe: {apiTimeoutMs: 10000, createPortalSession} as unknown as StripeBillingClient,
   resolveClerkUserId: async () => userId, env: {}, now: () => new Date(timestamp),
  }));
 }
 async function override() {
  await upsertBillingOverride(db, {
   id: 'override_support', clerkUserId: 'user_owner', planSlug: 'matrix_builder', status: 'active',
   maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0,
   defaultServerType: 'cpx42', allowedServerTypes: ['cpx42'], reason: 'Temporary access', createdBy: 'test',
   expiresAt: '2026-10-03T00:00:00.000Z', revokedAt: null, createdAt: timestamp,
  });
 }
 async function customer(userId = 'user_owner') {
  await upsertBillingCustomer(db, {clerkUserId: userId, stripeCustomerId: 'cus_owner', createdAt: timestamp, updatedAt: timestamp});
 }
 it.each(['', '?runtimeSlot=studio'])('keeps invoices accessible through a support override %s', async (query) => {
  await customer(); await override();
  const routes = app();
  const response = await routes.request('/billing/status' + query);
  expect(response.status).toBe(200);
  const status = MatrixBillingStatusSchema.parse(await response.json());
  expect(status.entitlement).toMatchObject({source: 'override', portalAvailable: true});
  expect(status.access.runtimeProxyAllowed).toBe(true);
  const portal = await routes.request('/billing/portal', {method: 'POST', body: '{}'});
  expect(portal.status).toBe(200);
  expect(createPortalSession).toHaveBeenCalledWith(expect.objectContaining({customerId: 'cus_owner'}));
 });
 it('does not advertise a portal for an override without a billing customer', async () => {
  await override();
  const status = await (await app().request('/billing/status')).json();
  expect(status.entitlement.portalAvailable).toBe(false);
  expect((await app().request('/billing/portal', {method: 'POST'})).status).toBe(404);
  expect(createPortalSession).not.toHaveBeenCalled();
 });
 it('cannot use another account billing customer', async () => {
  await customer('user_other'); await override();
  const status = await (await app().request('/billing/status')).json();
  expect(status.entitlement.portalAvailable).toBe(false);
  expect((await app().request('/billing/portal', {method: 'POST'})).status).toBe(404);
  expect(createPortalSession).not.toHaveBeenCalled();
 });
 it('requires authentication for billing records', async () => {
  await customer();
  expect((await app(null).request('/billing/status')).status).toBe(401);
  expect((await app(null).request('/billing/portal', {method: 'POST'})).status).toBe(401);
  expect(createPortalSession).not.toHaveBeenCalled();
 });
});
