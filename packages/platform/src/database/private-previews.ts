import type { NewUserMachine, PlatformDB, UserMachineRecord } from '../db.js';
import { mapUserMachine, toUserMachineRow } from './user-machine-records.js';

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

/**
 * Inserts the owner's Private Preview for a PR unless one is already active.
 * The partial unique index on owner and PR defines that singleton, so a racing
 * start resolves inside Postgres and returns false instead of failing.
 */
export async function insertPrivatePreviewIfAbsent(db: PlatformDB, record: NewUserMachine): Promise<boolean> {
  await db.ready;
  const inserted = await db.executor
    .insertInto('user_machines')
    .values(toUserMachineRow(record))
    .onConflict((oc) => oc
      .columns(['clerk_user_id', 'source_pr'])
      .where('provisioning_class', '=', 'private-preview')
      .where('deleted_at', 'is', null)
      .doNothing())
    .returning('machine_id')
    .executeTakeFirst();
  return inserted !== undefined;
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

export interface PrivatePreviewCursor {
  provisionedAt: string;
  machineId: string;
}

/** One page of a PR's active Private Previews, ordered for keyset pagination. */
export async function listActivePrivatePreviewsForPr(
  db: PlatformDB,
  sourcePr: number,
  after?: PrivatePreviewCursor,
): Promise<UserMachineRecord[]> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('provisioning_class', '=', 'private-preview')
    .where('source_pr', '=', sourcePr)
    .where('deleted_at', 'is', null);
  if (after) {
    query = query.where((eb) => eb.or([
      eb('provisioned_at', '>', after.provisionedAt),
      eb.and([eb('provisioned_at', '=', after.provisionedAt), eb('machine_id', '>', after.machineId)]),
    ]));
  }
  const rows = await query
    .orderBy('provisioned_at', 'asc')
    .orderBy('machine_id', 'asc')
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

/** One page of every owner's active Private Previews, ordered for keyset pagination. */
export async function listActivePrivatePreviews(
  db: PlatformDB,
  limit: number,
  after?: PrivatePreviewCursor,
): Promise<UserMachineRecord[]> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('provisioning_class', '=', 'private-preview')
    .where('deleted_at', 'is', null);
  if (after) {
    query = query.where((eb) => eb.or([
      eb('provisioned_at', '>', after.provisionedAt),
      eb.and([eb('provisioned_at', '=', after.provisionedAt), eb('machine_id', '>', after.machineId)]),
    ]));
  }
  const rows = await query
    .orderBy('provisioned_at', 'asc')
    .orderBy('machine_id', 'asc')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}
