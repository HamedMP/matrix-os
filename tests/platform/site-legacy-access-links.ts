import { randomUUID } from 'node:crypto';
import { SITE_ACCESS_LINK_CLAIM_TTL_MS } from '@matrix-os/contracts';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createSiteAccessSecret, hashSiteAccessSecret } from '../../packages/platform/src/sites/access-links.js';

/**
 * One-time link creation is retired (ENG-490). Existing links still drain, so
 * tests seed the rows older platform releases stored instead of creating them.
 */
export async function seedLegacyAccessLink(db: PlatformDB, siteId: string, options: { claimExpiresAt?: string } = {}) {
  const linkId = randomUUID();
  const secret = createSiteAccessSecret();
  const now = new Date();
  await db.executor.insertInto('public_site_access_links').values({
    id: linkId, site_id: siteId, claim_token_hash: hashSiteAccessSecret(secret), session_token_hash: null,
    created_at: now.toISOString(),
    claim_expires_at: options.claimExpiresAt ?? new Date(now.getTime() + SITE_ACCESS_LINK_CLAIM_TTL_MS).toISOString(),
    claimed_at: null, session_expires_at: null,
  }).execute();
  return { linkId, secret, url: `https://matrix.page/${siteId}#access=${linkId}.${secret}` };
}

/** Mark an existing site as a legacy one-time-link site, as older releases allowed. */
export async function markSiteLegacyPrivate(db: PlatformDB, siteId: string) {
  await db.executor.updateTable('public_sites').set({ access_mode: 'private_link' }).where('id', '=', siteId).execute();
}
