import { z } from 'zod/v4';
import type { Insertable, Selectable, Updateable } from 'kysely';
import {
  DEFAULT_DEVELOPER_TOOLS,
  parseDeveloperToolsJson,
  serializeDeveloperTools,
} from '../developer-tools.js';
import type {
  NewProviderDeletionQueueRecord,
  NewUserMachine,
  ProviderDeletionQueueRecord,
  ProviderDeletionQueueTable,
  UserMachineRecord,
  UserMachinesTable,
} from '../db.js';
import { parseStringArray } from './json.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): user machine and provider deletion row mappers. */

export const UserMachineProvisioningClassSchema = z.enum(['customer', 'preview']);

export type UserMachineProvisioningClass = z.infer<typeof UserMachineProvisioningClassSchema>;

const NullableProviderActionIdSchema = z.coerce.number().int().positive()
  .max(Number.MAX_SAFE_INTEGER).nullable();

export function parseNullableProviderActionId(value: number | string | null): number | null {
  return NullableProviderActionIdSchema.parse(value);
}

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

export function mapProviderDeletion(row: ProviderDeletionQueueTable): ProviderDeletionQueueRecord {
  return {
    id: row.id,
    providerServerId: row.provider_server_id,
    reason: row.reason,
    machineId: row.machine_id,
    handle: row.handle,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    lastError: row.last_error,
    completedAt: row.completed_at,
  };
}

export function toProviderDeletionRow(record: NewProviderDeletionQueueRecord): ProviderDeletionQueueTable {
  return {
    id: record.id,
    provider_server_id: record.providerServerId,
    reason: record.reason,
    machine_id: record.machineId ?? null,
    handle: record.handle ?? null,
    attempts: record.attempts ?? 0,
    next_attempt_at: record.nextAttemptAt,
    created_at: record.createdAt,
    last_error: record.lastError ?? null,
    completed_at: record.completedAt ?? null,
  };
}

