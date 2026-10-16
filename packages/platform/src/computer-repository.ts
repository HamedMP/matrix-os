import { sql } from 'kysely';

import {
  accessibleUserMachinePredicate,
  type PlatformDB,
  type UserMachineProvisioningClass,
} from './db.js';
import { mapUserMachine } from './database/user-machine-records.js';
import { canSelectPrivatePreviewComputer } from './computer-private-preview-access.js';
import type { PrivatePreviewEligibility } from './private-preview-eligibility.js';
import { HANDLE_PATTERN_SOURCE } from './platform-route-utils.js';

export interface UserRuntimeComputerRecord {
  handle: string;
  runtimeSlot: string;
  provisioningClass: UserMachineProvisioningClass;
  status: string;
  imageVersion: string | null;
}

const CANDIDATE_BATCH_LIMIT = 21;
const CANDIDATE_SCAN_LIMIT = 420;

export async function listUserRuntimeComputersByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  limit: number,
  selectedRuntimeSlot?: string,
  privatePreviewEligibility?: PrivatePreviewEligibility,
): Promise<UserRuntimeComputerRecord[]> {
  await db.ready;
  const boundedLimit = Math.max(1, Math.min(limit, CANDIDATE_BATCH_LIMIT));
  const rank = selectedRuntimeSlot
    ? sql<number>`CASE WHEN runtime_slot = ${selectedRuntimeSlot} THEN 0 WHEN runtime_slot = 'primary' THEN 1 ELSE 2 END`
    : sql<number>`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`;
  const baseQuery = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .select(rank.as('computer_rank'))
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('deleted_at', 'is', null)
    .where('provisioning_class', 'in', ['customer', 'preview', 'private-preview'])
    .where(sql<boolean>`${sql.ref('handle')} ~ ${HANDLE_PATTERN_SOURCE}`)
    .where(sql<boolean>`${sql.ref('runtime_slot')} ~ ${'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'}`)
    .where(sql<boolean>`char_length(${sql.ref('runtime_slot')}) <= 32`);
  const computers: UserRuntimeComputerRecord[] = [];
  let cursor: { rank: number; provisionedAt: string; machineId: string } | undefined;
  // Filter before consuming the result budget. A stable keyset avoids OFFSET
  // drift; each request retains at most one batch and one bounded result page.
  for (let scanned = 0; scanned < CANDIDATE_SCAN_LIMIT; scanned += CANDIDATE_BATCH_LIMIT) {
    let query = baseQuery;
    if (cursor) {
      query = query.where(sql<boolean>`(
        ${rank} > ${cursor.rank}
        OR (${rank} = ${cursor.rank} AND provisioned_at < ${cursor.provisionedAt})
        OR (${rank} = ${cursor.rank} AND provisioned_at = ${cursor.provisionedAt} AND machine_id > ${cursor.machineId})
      )`);
    }
    const rows = await query.orderBy(rank).orderBy('provisioned_at', 'desc')
      .orderBy('machine_id', 'asc').limit(CANDIDATE_BATCH_LIMIT).execute();
    for (const row of rows) {
      if (row.provisioning_class === 'private-preview'
        && !await canSelectPrivatePreviewComputer(mapUserMachine(row), clerkUserId, privatePreviewEligibility)) continue;
      computers.push({ handle: row.handle, runtimeSlot: row.runtime_slot,
        provisioningClass: row.provisioning_class as UserMachineProvisioningClass,
        status: row.status, imageVersion: row.image_version });
      if (computers.length === boundedLimit) return computers;
    }
    if (rows.length < CANDIDATE_BATCH_LIMIT) return computers;
    const last = rows[rows.length - 1];
    cursor = { rank: last.computer_rank, provisionedAt: last.provisioned_at, machineId: last.machine_id };
  }
  // Do not claim a complete/empty list when the work cap prevents proving it.
  // The route maps this to its existing generic unavailable response.
  throw new Error('Computer inventory scan limit exceeded');
}
