import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditBillingOwners, loadBillingAuditInventory, selectBillingAuditOwners,
  type BillingAuditSubscription } from '../../packages/platform/src/account-deletion/orphaned-billing-audit.js';
import { normalizeSubscriptionStatus } from '../../packages/platform/src/billing/stripe-webhook-projection.js';

describe('billing audit subscription inventory', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec("CREATE TABLE billing_subscriptions (clerk_user_id TEXT NOT NULL, status TEXT NOT NULL, stripe_subscription_id TEXT NOT NULL DEFAULT 'sub_terminal')");
  });
  afterEach(async () => { await db?.close(); });

  const load = async (readEndedStatus = async (_id: string) => 'incomplete_expired') => selectBillingAuditOwners(
    await loadBillingAuditInventory((sql, values) => db.query<BillingAuditSubscription>(sql, values)), { readEndedStatus });

  it('excludes the stored ended status and legacy terminal statuses, while retaining live trial and debt owners', async () => {
    await db.exec(`INSERT INTO billing_subscriptions (clerk_user_id, status) VALUES
      ('user_ended', 'ended'), ('user_canceled', 'canceled'), ('user_legacy', 'incomplete_expired'),
      ('user_live', 'active'), ('user_live', 'ended'), ('user_live', 'active'),
      ('user_trial', 'trialing'), ('user_debt', 'past_due'), ('user_unpaid', 'unpaid')`);
    await db.exec('BEGIN READ ONLY');
    expect(await load()).toEqual(['user_debt', 'user_live', 'user_trial', 'user_unpaid']);
    await db.exec('ROLLBACK');
    expect((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM billing_subscriptions')).rows[0].count).toBe(9);
  });

  it('retains a live paused subscription after the actual platform projection normalizes it to ended', async () => {
    expect(normalizeSubscriptionStatus('paused')).toBe('ended');
    await db.query('INSERT INTO billing_subscriptions VALUES ($1, $2, $3)', ['user_paused', normalizeSubscriptionStatus('paused'), 'sub_paused']);
    const readEndedStatus = vi.fn(async () => 'paused');
    const owners = await load(readEndedStatus);
    expect(owners).toEqual(['user_paused']);
    expect(readEndedStatus).toHaveBeenCalledWith('sub_paused');
    const request = vi.fn<typeof fetch>(async () => Response.json({ errors: [{ code: 'resource_not_found' }] }, { status: 404 }));
    expect((await auditBillingOwners(owners, { clerkSecretKey: 'fixture', request })).missing).toBe(1);
  });

  it('refuses to report completeness when an ambiguous ended subscription cannot be checked', async () => {
    await db.exec("INSERT INTO billing_subscriptions (clerk_user_id, status) VALUES ('user_unknown', 'ended')");
    await expect(load(async () => { throw new Error('provider unavailable'); })).rejects.toThrow('provider unavailable');
  });

  it.each(['distinct owners', 'one owner'])('refuses incomplete subscription inventory with %s', async mode => {
    await db.exec(`INSERT INTO billing_subscriptions SELECT ${mode === 'one owner' ? "'user_many'" : "'user_' || n"}, 'active', 'sub_' || n FROM generate_series(1, 1002) n`);
    await expect(load()).rejects.toThrow(/inventory/i);
  });
});
