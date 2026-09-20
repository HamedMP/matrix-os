import { sql } from 'kysely';
import type { NewUserMachine, PlatformDB, UserMachineRecord } from '../db.js';
import {
  mapUserMachine,
  toUserMachineRow,
  toUserMachineUpdate,
  type UserMachineProvisioningClass,
} from './user-machine-records.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): customer-VPS user machine queries. */

export async function lockUserMachineProvisioning(
  db: PlatformDB,
  clerkUserId: string,
): Promise<void> {
  await db.ready;
  await sql`
    SELECT pg_advisory_xact_lock(
      ('x' || substr(md5(${`user_machines:${clerkUserId}`}), 1, 16))::bit(64)::bigint
    )
  `.execute(db.executor);
}

export async function insertUserMachine(db: PlatformDB, record: NewUserMachine): Promise<void> {
  await db.ready;
  await db.executor.insertInto('user_machines').values(toUserMachineRow(record)).execute();
}

export async function getUserMachine(db: PlatformDB, machineId: string): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('machine_id', '=', machineId)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getActiveUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export function accessibleUserMachinePredicate(clerkUserId: string) {
  return sql<boolean>`(
    clerk_user_id = ${clerkUserId}
    OR (
      provisioning_class = 'preview'
      AND handle ~ '^pr-[1-9][0-9]{0,9}$'
      AND (runtime_slot = handle OR runtime_slot = 'preview')
      AND access_clerk_user_ids @> ARRAY[${clerkUserId}]::TEXT[]
    )
  )`;
}

export async function getAccessibleActiveUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN clerk_user_id = ${clerkUserId} AND runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getActiveUserMachineByHandle(
  db: PlatformDB,
  handle: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByHandle(
  db: PlatformDB,
  handle: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('handle', '=', handle)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot = 'primary',
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getAccessibleRunningUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByClerkIdForUpdate(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function listUserMachines(
  db: PlatformDB,
  options: { includeDeleted?: boolean } = {},
): Promise<UserMachineRecord[]> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .orderBy('provisioned_at', 'desc');
  if (!options.includeDeleted) {
    query = query.where('deleted_at', 'is', null);
  }
  const rows = await query.execute();
  return rows.map(mapUserMachine);
}

export async function listActiveUserMachinesByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .where('status', 'in', [
      'running',
      'provisioning',
      'recovering',
      'resizing',
      'suspending',
      'suspended',
      'resuming',
    ])
    .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
    .orderBy('provisioned_at', 'desc')
    .execute();
  return rows.map(mapUserMachine);
}

export async function listAccessibleActiveUserMachinesByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('deleted_at', 'is', null)
    .where('status', 'in', ['running', 'provisioning', 'recovering', 'resizing'])
    .orderBy(sql`CASE WHEN clerk_user_id = ${clerkUserId} AND runtime_slot = 'primary' THEN 0 ELSE 1 END`)
    .orderBy('provisioned_at', 'desc')
    .execute();
  return rows.map(mapUserMachine);
}

export async function listNonDeletedUserMachinesByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
    .orderBy('provisioned_at', 'desc')
    .execute();
  return rows.map(mapUserMachine);
}

export async function updateUserMachine(
  db: PlatformDB,
  machineId: string,
  values: Partial<NewUserMachine>,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .execute();
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

export async function listStaleUserMachines(
  db: PlatformDB,
  statuses: string[],
  olderThanIso: string,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  if (statuses.length === 0) return [];
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', 'in', statuses)
    .where('provisioned_at', '<', olderThanIso)
    .where('deleted_at', 'is', null)
    .orderBy('provisioned_at')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

// ---------------------------------------------------------------------------
// Onboarding journey (spec 092)
// ---------------------------------------------------------------------------
