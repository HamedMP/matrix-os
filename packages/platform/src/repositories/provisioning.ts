/**
 * Provider-deletion queue + machine listing persistence.
 *
 * Extracted from ../db.ts (Phase 1-A2). Pure move: no logic changes.
 */
import type { PlatformDB } from './schema-tables.js';
import type {
  NewProviderDeletionQueueRecord,
  ProviderDeletionQueueRecord,
  UserMachineProvisioningClass,
  UserMachineRecord,
} from './schema-records.js';
import { mapUserMachine } from './machines.js';
import { mapProviderDeletion, toProviderDeletionRow } from './releases.js';

export async function insertProviderDeletion(
  db: PlatformDB,
  record: NewProviderDeletionQueueRecord,
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('provider_deletion_queue')
    .values(toProviderDeletionRow(record))
    .onConflict((oc) => oc.column('provider_server_id')
      .where('completed_at', 'is', null).doNothing())
    .execute();
}

export async function listPendingProviderDeletions(
  db: PlatformDB,
  nowIso: string,
  limit: number,
): Promise<ProviderDeletionQueueRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('provider_deletion_queue')
    .selectAll()
    .where('completed_at', 'is', null)
    .where('next_attempt_at', '<=', nowIso)
    .orderBy('next_attempt_at')
    .limit(limit)
    .execute();
  return rows.map(mapProviderDeletion);
}

export async function listRunningUserMachines(
  db: PlatformDB,
  limit: number,
  filters: {
    handle?: string;
    provisioningClass?: UserMachineProvisioningClass;
  } = {},
): Promise<UserMachineRecord[]> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', '=', 'running')
    .where('deleted_at', 'is', null);
  if (filters.handle !== undefined) {
    query = query.where('handle', '=', filters.handle);
  }
  if (filters.provisioningClass !== undefined) {
    query = query.where('provisioning_class', '=', filters.provisioningClass);
  }
  const rows = await query
    .orderBy('last_seen_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function listAllUserMachines(
  db: PlatformDB,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', '!=', 'deleted')
    .where('deleted_at', 'is', null)
    .orderBy('last_seen_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}
