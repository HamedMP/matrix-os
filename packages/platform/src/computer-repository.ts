import { sql } from 'kysely';

import {
  accessibleUserMachinePredicate,
  type PlatformDB,
  type UserMachineProvisioningClass,
} from './db.js';
import { HANDLE_PATTERN_SOURCE } from './platform-route-utils.js';

export interface UserRuntimeComputerRecord {
  handle: string;
  runtimeSlot: string;
  provisioningClass: UserMachineProvisioningClass;
  status: string;
  imageVersion: string | null;
}

export async function listUserRuntimeComputersByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  limit: number,
  selectedRuntimeSlot?: string,
): Promise<UserRuntimeComputerRecord[]> {
  await db.ready;
  const boundedLimit = Math.max(1, Math.min(limit, 21));
  let query = db.executor
    .selectFrom('user_machines')
    .select(['handle', 'runtime_slot', 'provisioning_class', 'status', 'image_version'])
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('deleted_at', 'is', null)
    .where('provisioning_class', 'in', ['customer', 'preview'])
    .where(sql<boolean>`${sql.ref('handle')} ~ ${HANDLE_PATTERN_SOURCE}`)
    .where(sql<boolean>`${sql.ref('runtime_slot')} ~ ${'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'}`)
    .where(sql<boolean>`char_length(${sql.ref('runtime_slot')}) <= 32`);
  if (selectedRuntimeSlot) {
    query = query.orderBy(sql`CASE WHEN runtime_slot = ${selectedRuntimeSlot} THEN 0 WHEN runtime_slot = 'primary' THEN 1 ELSE 2 END`);
  } else {
    query = query.orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`);
  }
  const rows = await query
    .orderBy('provisioned_at', 'desc')
    .limit(boundedLimit)
    .execute();
  return rows.map((row) => ({
    handle: row.handle,
    runtimeSlot: row.runtime_slot,
    provisioningClass: row.provisioning_class === 'preview' ? 'preview' : 'customer',
    status: row.status,
    imageVersion: row.image_version,
  }));
}
