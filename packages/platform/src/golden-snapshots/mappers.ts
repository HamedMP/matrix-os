/**
 * Golden snapshot row mappers.
 *
 * Extracted from ../golden-snapshot-repository.ts (Phase 1-A4). Pure move: no logic changes.
 */

import type { PlatformDB } from '../db.js';
import {

  canTransitionGoldenSnapshot,
  compatibilityKey,
  DEFAULT_GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS,
  GoldenSnapshotBaseGenerationSchema,
  GoldenSnapshotBundleVersionSchema,
  GoldenSnapshotBuildPhaseSchema,
  GoldenSnapshotBuildStatusSchema,
  GoldenSnapshotCompatibilitySchema,
  GoldenSnapshotStateSchema,
  GoldenSnapshotValidationSummarySchema,
  type GoldenSnapshotCompatibility,
  type GoldenSnapshotState,
  type GoldenSnapshotValidationSummary,
} from '../golden-snapshot-schema.js';
import { chooseGoldenSnapshot } from '../golden-snapshot-selection.js';

import {
  BuildRowSchema,
  CleanupRowSchema,
  CreateIntentRowSchema,
  LeaseRowSchema,
  RolloutControlRowSchema,
  SnapshotRowSchema,
} from './schemas.js';

export function mapSnapshot(input: unknown) {
  const row = SnapshotRowSchema.parse(input);
  return {
    snapshotId: row.snapshot_id,
    bundleVersion: row.bundle_version,
    bundleSha256: row.bundle_sha256,
    sourceGitCommit: row.source_git_commit,
    compatibilityKey: row.compatibility_key,
    compatibility: {
      provider: row.provider,
      architecture: row.architecture,
      region: row.region,
      baseImage: row.base_image,
      baseGeneration: row.base_generation,
      bootMode: row.boot_mode,
      activationAbi: row.activation_abi,
      minimumDiskGb: row.minimum_disk_gb,
    } satisfies GoldenSnapshotCompatibility,
    testMode: row.test_mode,
    imageGeneration: row.image_generation,
    state: row.state,
    providerImageId: row.provider_image_id,
    providerImageStatus: row.provider_image_status,
    imageDiskGb: row.image_disk_gb,
    imageArchitecture: row.image_architecture,
    validationSummary: row.validation_summary,
    failureCode: row.failure_code,
    readyAt: row.ready_at,
    quarantinedAt: row.quarantined_at,
    retiringAt: row.retiring_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}


export function mapBuild(input: unknown) {
  const row = BuildRowSchema.parse(input);
  return {
    buildId: row.build_id,
    snapshotId: row.snapshot_id,
    phase: row.phase,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    callbackPhase: row.callback_phase,
    callbackTokenHash: row.callback_token_hash,
    callbackExpiresAt: row.callback_expires_at,
    callbackEventId: row.callback_event_id,
    callbackPayloadSha256: row.callback_payload_sha256,
    callbackOutcome: row.callback_outcome,
    builderMachineIdSha256: row.builder_machine_id_sha256,
    builderSshHostKeySha256: row.builder_ssh_host_key_sha256,
    validationCloneOrdinal: row.validation_clone_ordinal,
    firstValidationMachineIdSha256: row.first_validation_machine_id_sha256,
    firstValidationSshHostKeySha256: row.first_validation_ssh_host_key_sha256,
    providerBuilderId: row.provider_builder_id,
    providerBuilderActionId: row.provider_builder_action_id,
    providerSnapshotActionId: row.provider_snapshot_action_id,
    providerValidationId: row.provider_validation_id,
    providerValidationActionId: row.provider_validation_action_id,
    pendingOperation: row.pending_operation,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}


export function mapLease(input: unknown) {
  const row = LeaseRowSchema.parse(input);
  return {
    leaseId: row.lease_id,
    snapshotId: row.snapshot_id,
    machineId: row.machine_id,
    purpose: row.purpose,
    targetBundleVersion: row.target_bundle_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
  };
}


export function mapCreateIntent(input: unknown) {
  const row = CreateIntentRowSchema.parse(input);
  return {
    intentId: row.intent_id,
    snapshotId: row.snapshot_id,
    leaseId: row.lease_id,
    machineId: row.machine_id,
    purpose: row.purpose,
    rolloutGeneration: row.rollout_generation,
    state: row.state,
    providerCreateActionId: row.provider_create_action_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}


export function mapRolloutControl(input: unknown) {
  const row = RolloutControlRowSchema.parse(input);
  return {
    compatibilityKey: row.compatibility_key,
    enabled: row.enabled,
    percentage: row.percentage,
    generation: row.generation,
    updatedAt: row.updated_at,
  };
}


export function mapCleanup(input: unknown) {
  const row = CleanupRowSchema.parse(input);
  return {
    cleanupId: row.cleanup_id,
    snapshotId: row.snapshot_id,
    buildId: row.build_id,
    resourceType: row.resource_type,
    providerResourceId: row.provider_resource_id,
    provenanceKey: row.provenance_key,
    reason: row.reason,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
