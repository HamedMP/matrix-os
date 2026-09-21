/**
 * User-machine (VPS) persistence.
 *
 * Extracted from ../db.ts (Phase 1-A2). Pure move: no logic changes.
 */
import { type Insertable, type Selectable, type Updateable, sql } from 'kysely';
import { z } from 'zod/v4';
import {
  DEFAULT_DEVELOPER_TOOLS,
  parseDeveloperToolsJson,
  serializeDeveloperTools,
} from '../developer-tools.js';
import type { PlatformDatabase, PlatformDB, UserMachinesTable } from './schema-tables.js';
import {
  UserMachineProvisioningClassSchema,
  parseNullableProviderActionId,
} from './schema-records.js';
import type {
  NewUserMachine,
  UserMachineRecord,
} from './schema-records.js';

export function mapUserMachine(row: Selectable<UserMachinesTable>): UserMachineRecord {
  return {
    machineId: row.machine_id,
    clerkUserId: row.clerk_user_id,
    handle: row.handle,
    runtimeSlot: row.runtime_slot,
    provisioningClass: UserMachineProvisioningClassSchema.parse(row.provisioning_class),
    accessClerkUserIds: row.access_clerk_user_ids,
    developerTools: parseDeveloperToolsJson(row.developer_tools),
    hetznerServerId: row.hetzner_server_id,
    publicIPv4: row.public_ipv4,
    publicIPv6: row.public_ipv6,
    status: row.status,
    imageVersion: row.image_version,
    sourceSnapshotId: row.source_snapshot_id,
    sourceBaseGeneration: row.source_base_generation,
    targetBundleVersion: row.target_bundle_version,
    targetBundleSha256: row.target_bundle_sha256,
    recoveryCreateActionId: parseNullableProviderActionId(
      row.recovery_create_action_id as number | string | null,
    ),
    recoveryEncryptedPayload: row.recovery_encrypted_payload,
    recoveryOldServerId: row.recovery_old_server_id,
    recoveryOldPublicIPv4: row.recovery_old_public_ipv4,
    serverType: row.server_type,
    location: row.location,
    registrationTokenHash: row.registration_token_hash,
    registrationTokenExpiresAt: row.registration_token_expires_at,
    provisionedAt: row.provisioned_at,
    lastSeenAt: row.last_seen_at,
    deletedAt: row.deleted_at,
    failureCode: row.failure_code,
    failureAt: row.failure_at,
    resizeStartedAt: row.resize_started_at,
    resizeTargetServerType: row.resize_target_server_type,
    attempt: row.attempt,
    activationState: z.enum(['awaiting_billing', 'authorized']).parse(row.activation_state ?? 'authorized'),
    prebillingIntentId: row.prebilling_intent_id,
    activationAuthorizedAt: row.activation_authorized_at,
  };
}

export function toUserMachineRow(record: NewUserMachine): Insertable<UserMachinesTable> {
  return {
    machine_id: record.machineId,
    clerk_user_id: record.clerkUserId,
    handle: record.handle,
    runtime_slot: record.runtimeSlot ?? 'primary',
    provisioning_class: record.provisioningClass ?? 'customer',
    access_clerk_user_ids: record.accessClerkUserIds ?? [],
    developer_tools: serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
    hetzner_server_id: record.hetznerServerId ?? null,
    public_ipv4: record.publicIPv4 ?? null,
    public_ipv6: record.publicIPv6 ?? null,
    status: record.status,
    image_version: record.imageVersion ?? null,
    source_snapshot_id: record.sourceSnapshotId ?? null,
    source_base_generation: record.sourceBaseGeneration ?? null,
    target_bundle_version: record.targetBundleVersion ?? null,
    target_bundle_sha256: record.targetBundleSha256 ?? null,
    recovery_create_action_id: record.recoveryCreateActionId ?? null,
    recovery_encrypted_payload: record.recoveryEncryptedPayload ?? null,
    recovery_old_server_id: record.recoveryOldServerId ?? null,
    recovery_old_public_ipv4: record.recoveryOldPublicIPv4 ?? null,
    server_type: record.serverType ?? null,
    location: record.location ?? null,
    registration_token_hash: record.registrationTokenHash ?? null,
    registration_token_expires_at: record.registrationTokenExpiresAt ?? null,
    provisioned_at: record.provisionedAt,
    last_seen_at: record.lastSeenAt ?? null,
    deleted_at: record.deletedAt ?? null,
    failure_code: record.failureCode ?? null,
    failure_at: record.failureAt ?? null,
    resize_started_at: record.resizeStartedAt ?? null,
    resize_target_server_type: record.resizeTargetServerType ?? null,
    attempt: record.attempt ?? 1,
    activation_state: record.activationState ?? 'authorized',
    prebilling_intent_id: record.prebillingIntentId ?? null,
    activation_authorized_at: record.activationAuthorizedAt ?? null,
  };
}

export function toUserMachineUpdate(values: Partial<NewUserMachine>): Updateable<UserMachinesTable> {
  const update: Updateable<UserMachinesTable> = {};
  if (values.machineId !== undefined) update.machine_id = values.machineId;
  if (values.clerkUserId !== undefined) update.clerk_user_id = values.clerkUserId;
  if (values.handle !== undefined) update.handle = values.handle;
  if (values.runtimeSlot !== undefined) update.runtime_slot = values.runtimeSlot;
  if (values.provisioningClass !== undefined) update.provisioning_class = values.provisioningClass;
  if (values.accessClerkUserIds !== undefined) update.access_clerk_user_ids = values.accessClerkUserIds;
  if (values.developerTools !== undefined) update.developer_tools = serializeDeveloperTools(values.developerTools);
  if (values.hetznerServerId !== undefined) update.hetzner_server_id = values.hetznerServerId;
  if (values.publicIPv4 !== undefined) update.public_ipv4 = values.publicIPv4;
  if (values.publicIPv6 !== undefined) update.public_ipv6 = values.publicIPv6;
  if (values.status !== undefined) update.status = values.status;
  if (values.imageVersion !== undefined) update.image_version = values.imageVersion;
  if (values.sourceSnapshotId !== undefined) update.source_snapshot_id = values.sourceSnapshotId;
  if (values.sourceBaseGeneration !== undefined) update.source_base_generation = values.sourceBaseGeneration;
  if (values.targetBundleVersion !== undefined) update.target_bundle_version = values.targetBundleVersion;
  if (values.targetBundleSha256 !== undefined) update.target_bundle_sha256 = values.targetBundleSha256;
  if (values.recoveryCreateActionId !== undefined) update.recovery_create_action_id = values.recoveryCreateActionId;
  if (values.recoveryEncryptedPayload !== undefined) update.recovery_encrypted_payload = values.recoveryEncryptedPayload;
  if (values.recoveryOldServerId !== undefined) update.recovery_old_server_id = values.recoveryOldServerId;
  if (values.recoveryOldPublicIPv4 !== undefined) update.recovery_old_public_ipv4 = values.recoveryOldPublicIPv4;
  if (values.serverType !== undefined) update.server_type = values.serverType;
  if (values.location !== undefined) update.location = values.location;
  if (values.registrationTokenHash !== undefined) update.registration_token_hash = values.registrationTokenHash;
  if (values.registrationTokenExpiresAt !== undefined) update.registration_token_expires_at = values.registrationTokenExpiresAt;
  if (values.provisionedAt !== undefined) update.provisioned_at = values.provisionedAt;
  if (values.lastSeenAt !== undefined) update.last_seen_at = values.lastSeenAt;
  if (values.deletedAt !== undefined) update.deleted_at = values.deletedAt;
  if (values.failureCode !== undefined) update.failure_code = values.failureCode;
  if (values.failureAt !== undefined) update.failure_at = values.failureAt;
  if (values.resizeStartedAt !== undefined) update.resize_started_at = values.resizeStartedAt;
  if (values.resizeTargetServerType !== undefined) update.resize_target_server_type = values.resizeTargetServerType;
  if (values.attempt !== undefined) update.attempt = values.attempt;
  if (values.activationState !== undefined) update.activation_state = values.activationState;
  if (values.prebillingIntentId !== undefined) update.prebilling_intent_id = values.prebillingIntentId;
  if (values.activationAuthorizedAt !== undefined) update.activation_authorized_at = values.activationAuthorizedAt;
  return update;
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
