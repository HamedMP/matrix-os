import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';

/** Called in the machine recovery transaction, after the owner lock and machine
 * claim. Keep site IDs, aliases, revisions and immutable versions unchanged.
 * Historical schemas may not yet have the independently migrated sites scope. */
export async function remapRecoveredSites(
  trx: PlatformDB, ownerId: string, previousMachineId: string, currentMachineId: string,
): Promise<void> {
  const registry = await sql<{ present: boolean }>`SELECT to_regclass('public_sites') IS NOT NULL AS present`.execute(trx.executor);
  if (!registry.rows[0]?.present) return;
  await trx.executor.updateTable('public_sites').set({ machine_id: currentMachineId })
    .where('owner_id', '=', ownerId).where('machine_id', '=', previousMachineId).execute();
}
