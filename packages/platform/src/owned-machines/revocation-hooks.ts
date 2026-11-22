import type { PlatformDB, UserMachineRecord } from '../db.js';
import { revokeSiteEmailAuthorityForTransition } from '../sites/email-invitations.js';
import type { OwnedRevocationHook } from './repository.js';

const SITE_BATCH = 200;

/**
 * Spec 2707 (D7): removing an owned computer unpublishes its sites in the same
 * transaction that revokes it. Viewers are cut at commit because they are
 * served from storage by the platform, never from the machine. Stored
 * versions are left for the site lifecycle; only this machine's sites change.
 */
export const unpublishOwnedMachineSites: OwnedRevocationHook = async (
  trx: PlatformDB, machine: UserMachineRecord,
) => {
  // Batches keep each statement bounded; every batch unpublishes what it read,
  // so the loop ends when no published site of this machine remains.
  for (;;) {
    const sites = await trx.executor.selectFrom('public_sites').select(['id', 'access_mode'])
      .where('machine_id', '=', machine.machineId).where('owner_id', '=', machine.clerkUserId)
      .where('status', '=', 'published').orderBy('id').limit(SITE_BATCH).forUpdate().execute();
    for (const site of sites) {
      await trx.executor.deleteFrom('public_site_access_links').where('site_id', '=', site.id).execute();
      if (site.access_mode === 'private_email') {
        await revokeSiteEmailAuthorityForTransition(trx, site.id, machine.clerkUserId, 'unpublished');
      }
      await trx.executor.updateTable('public_sites')
        .set((eb) => ({ status: 'unpublished', revision: eb('revision', '+', 1) }))
        .where('id', '=', site.id).execute();
    }
    if (sites.length < SITE_BATCH) return;
  }
};

export const OWNED_REVOCATION_HOOKS: readonly OwnedRevocationHook[] = [unpublishOwnedMachineSites];
