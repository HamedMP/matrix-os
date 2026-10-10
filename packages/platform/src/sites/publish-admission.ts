import type { PlatformDB } from '../db.js';
import { SiteError, type SiteOwner } from './types.js';

/** One process owns one registered sites service. No queue or inactive entries:
 * at most four owners are retained, and cleanup releases each accepted lease.
 * Never expire a live lease while its transaction/upload can still run. */
export function createPublishAdmission() {
  const activeOwners = new Set<string>();
  return async function admitted<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    if (activeOwners.has(ownerId) || activeOwners.size >= 4) throw new SiteError('unavailable');
    activeOwners.add(ownerId);
    try { return await work(); }
    finally { activeOwners.delete(ownerId); }
  };
}

/** Owner admission lock precedes this machine lock, then site locks. The HTTP
 * credential snapshot must still match the authoritative registry at the write. */
export async function assertCurrentPublishingRuntime(trx: PlatformDB, owner: SiteOwner): Promise<void> {
  const machine = await trx.executor.selectFrom('user_machines')
    .select(['handle', 'runtime_slot', 'runtime_token_epoch', 'access_clerk_user_ids'])
    .where('machine_id', '=', owner.machineId).where('clerk_user_id', '=', owner.ownerId)
    .where('status', '=', 'running').where('activation_state', '=', 'authorized').where('deleted_at', 'is', null)
    .where('provisioning_class', '=', 'customer').forUpdate().executeTakeFirst();
  const authenticated = owner.authenticatedRuntime;
  if (!machine || machine.access_clerk_user_ids.length !== 0 || (authenticated && (
    machine.handle !== authenticated.handle || machine.runtime_slot !== authenticated.runtimeSlot
    || machine.runtime_token_epoch !== authenticated.runtimeTokenEpoch
  ))) throw new SiteError('unavailable');
}
