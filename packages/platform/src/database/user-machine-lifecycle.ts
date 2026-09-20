import { sql } from 'kysely';
import type {
  NewProviderDeletionQueueRecord,
  NewUserMachine,
  PlatformDB,
  ProviderDeletionQueueRecord,
  UserMachineRecord,
} from '../db.js';
import { mapProviderDeletion, mapUserMachine, toProviderDeletionRow, toUserMachineUpdate } from './user-machine-records.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): user machine lifecycle claims and the provider deletion queue. */

export async function claimRunningUserMachineResize(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
  resizeStartedAt: string,
  resizeTargetServerType: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({
      status: 'resizing',
      failure_code: null,
      failure_at: null,
      resize_started_at: resizeStartedAt,
      resize_target_server_type: resizeTargetServerType,
    })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'running')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function completeUserMachineResize(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
  values: Partial<NewUserMachine>,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'resizing')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimRunningUserMachineBillingSuspend(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'suspending', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', 'in', ['running', 'resuming'])
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function completeUserMachineBillingSuspend(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'suspended', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'suspending')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimSuspendedUserMachineBillingResume(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'resuming', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', 'in', ['suspended', 'suspending'])
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function completeUserMachineBillingResume(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'running', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'resuming')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function listStaleResizingUserMachines(
  db: PlatformDB,
  olderThanIso: string,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', '=', 'resizing')
    .where('resize_started_at', 'is not', null)
    .where('resize_started_at', '<', olderThanIso)
    .where('deleted_at', 'is', null)
    .orderBy('resize_started_at')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function completeUserMachineRegistration(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
  expectedRegistrationTokenHash: string,
  expiresAfterIso: string,
  values: Partial<NewUserMachine>,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('registration_token_hash', '=', expectedRegistrationTokenHash)
    .where('registration_token_expires_at', '>=', expiresAfterIso)
    .where('status', 'in', ['provisioning', 'recovering'])
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimUserMachineRecovery(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot = 'primary',
  intent?: {
    machineId: string;
    encryptedPayload: string;
    serverType: string;
    registrationTokenHash: string;
    registrationTokenExpiresAt: string;
  },
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set(intent ? {
      machine_id: intent.machineId,
      recovery_encrypted_payload: intent.encryptedPayload,
      recovery_old_server_id: sql<number | null>`hetzner_server_id`,
      recovery_old_public_ipv4: sql<string | null>`public_ipv4`,
      server_type: intent.serverType,
      registration_token_hash: intent.registrationTokenHash,
      registration_token_expires_at: intent.registrationTokenExpiresAt,
      status: 'recovering',
      hetzner_server_id: null,
      recovery_create_action_id: null,
      failure_code: null,
      failure_at: null,
    } : {
      status: 'recovering',
      hetzner_server_id: null,
      public_ipv4: null,
      public_ipv6: null,
      recovery_old_public_ipv4: null,
      failure_code: null,
      failure_at: null,
    })
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'recovering')
    .where('status', '!=', 'resizing')
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

/**
 * Soft-deletes a failed machine row so it stops occupying the active
 * (clerk_user_id, runtime_slot) unique slot, letting a retry provision a fresh
 * machine. The failure status is preserved for audit; only `deleted_at` is set.
 * The `status = 'failed'` guard encodes the invariant at the DB layer: this
 * helper must never silently retire a live (provisioning/recovering/running)
 * machine, even if a future caller forgets the status check.
 */

export async function retireUserMachine(
  db: PlatformDB,
  machineId: string,
  retiredAt: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('user_machines')
    .set({ deleted_at: retiredAt })
    .where('machine_id', '=', machineId)
    .where('deleted_at', 'is', null)
    .where('status', '=', 'failed')
    .execute();
}

export async function claimUserMachineDelete(
  db: PlatformDB,
  machineId: string,
  deletedAt: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'deleted', deleted_at: deletedAt })
    .where('machine_id', '=', machineId)
    .where('deleted_at', 'is', null)
    .where('status', 'not in', ['resizing', 'suspending', 'resuming'])
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function softDeleteUserMachine(db: PlatformDB, machineId: string, deletedAt: string): Promise<void> {
  await claimUserMachineDelete(db, machineId, deletedAt);
}

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

export async function markProviderDeletionCompleted(
  db: PlatformDB,
  id: string,
  completedAt: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('provider_deletion_queue')
    .set({ completed_at: completedAt, last_error: null })
    .where('id', '=', id)
    .execute();
}

export async function markProviderDeletionFailed(
  db: PlatformDB,
  id: string,
  attempts: number,
  nextAttemptAt: string,
  lastError: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('provider_deletion_queue')
    .set({
      attempts,
      next_attempt_at: nextAttemptAt,
      last_error: lastError,
    })
    .where('id', '=', id)
    .where('completed_at', 'is', null)
    .execute();
}
