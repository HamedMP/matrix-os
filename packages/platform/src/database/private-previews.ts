import type { PlatformDB, UserMachineRecord } from '../db.js';
import { mapUserMachine } from './user-machine-records.js';

/** Spec 537 Private Preview reads and the owner's confirmed-version write. */

const PRIVATE_PREVIEW_LIST_LIMIT = 50;

export async function getActivePrivatePreviewForOwnerPr(
  db: PlatformDB,
  clerkUserId: string,
  sourcePr: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('provisioning_class', '=', 'private-preview')
    .where('clerk_user_id', '=', clerkUserId)
    .where('source_pr', '=', sourcePr)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function listActivePrivatePreviewsForOwner(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('provisioning_class', '=', 'private-preview')
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .orderBy('provisioned_at', 'desc')
    .limit(PRIVATE_PREVIEW_LIST_LIMIT)
    .execute();
  return rows.map(mapUserMachine);
}

export async function listActivePrivatePreviewsForPr(
  db: PlatformDB,
  sourcePr: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('provisioning_class', '=', 'private-preview')
    .where('source_pr', '=', sourcePr)
    .where('deleted_at', 'is', null)
    .orderBy('provisioned_at', 'asc')
    .limit(PRIVATE_PREVIEW_LIST_LIMIT)
    .execute();
  return rows.map(mapUserMachine);
}

/**
 * Records the owner's newly confirmed version in one guarded statement, so a
 * concurrent destroy, status change, or ownership mismatch leaves it unchanged.
 */
export async function confirmPrivatePreviewBundle(
  db: PlatformDB,
  input: { machineId: string; clerkUserId: string; bundleVersion: string },
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ confirmed_bundle_version: input.bundleVersion })
    .where('machine_id', '=', input.machineId)
    .where('clerk_user_id', '=', input.clerkUserId)
    .where('provisioning_class', '=', 'private-preview')
    .where('status', '=', 'running')
    .where('public_ipv4', 'is not', null)
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

/** Oldest first, so an expiry sweep reaches the longest-running machines within its bound. */
export async function listActivePrivatePreviews(
  db: PlatformDB,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('provisioning_class', '=', 'private-preview')
    .where('deleted_at', 'is', null)
    .orderBy('provisioned_at', 'asc')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}
