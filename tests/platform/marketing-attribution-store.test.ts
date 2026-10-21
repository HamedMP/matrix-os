import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimCheckoutAttempt, type PlatformDB } from '../../packages/platform/src/db.js';
import { rememberMarketingAttribution } from '../../packages/platform/src/billing/marketing-attribution-store.js';
import { expireGoogleTracking } from '../../packages/platform/src/billing/google-purchase-store.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

describe('immutable marketing Checkout attribution', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  async function attempt(at = new Date().toISOString()) {
    return (await claimCheckoutAttempt(db, { id: 'marketing_attempt', clerkUserId: 'user_fixture', runtimeSlot: 'primary',
      planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1', createdAt: at })).attempt;
  }
  it('freezes absence as well as acceptance for the same attempt', async () => {
    const saved = await attempt();
    const at = new Date().toISOString();
    expect(await rememberMarketingAttribution(db, saved.id, 'user_fixture', undefined, at)).toBeUndefined();
    expect(await rememberMarketingAttribution(db, saved.id, 'user_fixture', { rdt_cid: 'later-click' }, at)).toBeUndefined();
  });
  it('does not let another owner overwrite or retrieve a snapshot', async () => {
    const saved = await attempt();
    const at = new Date().toISOString();
    await rememberMarketingAttribution(db, saved.id, 'user_fixture', { rdt_cid: 'exact-click' }, at);
    await expect(rememberMarketingAttribution(db, saved.id, 'user_other', { rdt_cid: 'replacement' }, at)).rejects.toThrow('owner mismatch');
    expect(await rememberMarketingAttribution(db, saved.id, 'user_fixture', undefined, at)).toEqual({ rdt_cid: 'exact-click' });
  });
  it('purges snapshots after seven days even with external delivery disabled', async () => {
    const at = new Date(Date.now() - 8 * 86400000).toISOString();
    const saved = await attempt(at);
    await rememberMarketingAttribution(db, saved.id, 'user_fixture', { rdt_cid: 'expired' }, at);
    expect(await db.executor.selectFrom('billing_marketing_checkout_attribution').selectAll().execute()).toHaveLength(1);
    await expireGoogleTracking(db);
    expect(await db.executor.selectFrom('billing_marketing_checkout_attribution').selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom('billing_marketing_checkout_attribution').selectAll().execute()).toEqual([]);
  });
});
