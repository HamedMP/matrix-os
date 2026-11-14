import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditBillingOwners, loadBillingAuditOwners } from '../../packages/platform/src/account-deletion/orphaned-billing-audit.js';

describe('billing audit subscription inventory', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE billing_subscriptions (clerk_user_id TEXT NOT NULL, status TEXT NOT NULL)');
  });
  afterEach(async () => { await db?.close(); });

  const load = () => loadBillingAuditOwners((sql, values) => db.query<{ clerk_user_id: string }>(sql, values));

  it('excludes the stored ended status and legacy terminal statuses, while retaining live trial and debt owners', async () => {
    await db.exec(`INSERT INTO billing_subscriptions VALUES
      ('user_ended', 'ended'), ('user_canceled', 'canceled'), ('user_legacy', 'incomplete_expired'),
      ('user_live', 'active'), ('user_live', 'ended'), ('user_live', 'active'),
      ('user_trial', 'trialing'), ('user_debt', 'past_due'), ('user_unpaid', 'unpaid')`);
    await db.exec('BEGIN READ ONLY');
    expect(await load()).toEqual(['user_debt', 'user_live', 'user_trial', 'user_unpaid']);
    await db.exec('ROLLBACK');
    expect((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM billing_subscriptions')).rows[0].count).toBe(9);
  });

  it('returns an overflow sentinel so an incomplete inventory cannot pass the identity audit', async () => {
    await db.exec("INSERT INTO billing_subscriptions SELECT 'user_' || n, 'active' FROM generate_series(1, 1002) n");
    const owners = await load();
    expect(owners).toHaveLength(1001);
    const request = vi.fn<typeof fetch>();
    await expect(auditBillingOwners(owners, { clerkSecretKey: 'fixture', request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
