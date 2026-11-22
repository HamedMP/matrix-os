import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { addFreeTierInvite, getFreeTierInvite, redeemFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

/**
 * Invite redemption on real Postgres across independent pools (spec 2691,
 * ENG-520; ported from PR #3414). Faults detected: one invite admitting two
 * free owners under concurrent redemption, and a rolled-back admission still
 * consuming the invite.
 */
const OWNER = 'user_invited1';

describe.skipIf(!freeTierPostgresUrl)('free tier invite redemption against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_invites', 2); });
  afterAll(async () => { await scoped?.close(); });

  it('lets exactly one of many concurrent redemptions across pools consume an invite', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    await addFreeTierInvite(a, { clerkUserId: OWNER, invitedBy: 'ops' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      redeemFreeTierInvite(index % 2 === 0 ? a : b, OWNER)));
    expect(results.filter((result) => result === 'redeemed')).toHaveLength(1);
    expect(results.filter((result) => result === 'already_redeemed')).toHaveLength(19);
  });

  it('does not consume an invite when the surrounding transaction rolls back', async () => {
    const [a] = scoped.pools as [PlatformDB];
    await addFreeTierInvite(a, { clerkUserId: 'user_rollback', invitedBy: 'ops' });
    await expect(a.transaction(async (trx) => {
      expect(await redeemFreeTierInvite(trx, 'user_rollback')).toBe('redeemed');
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect((await getFreeTierInvite(a, 'user_rollback'))?.consumedAt).toBeNull();
  });
});
