/**
 * Golden snapshot input schemas, cursors, and row codecs.
 *
 * Extracted from ../golden-snapshot-repository.ts (Phase 1-A4). Pure move: no logic changes.
 */

import { z } from 'zod/v4';
import type {
  mapBuild,
  mapCleanup,
  mapCreateIntent,
  mapLease,
  mapRolloutControl,
  mapSnapshot,
} from './mappers.js';

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

export const UuidSchema = z.string().uuid();


export const IsoDateSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());


export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);


export const BoundedCodeSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);


export const RetentionInputSchema = z.object({
  retentionLimit: z.number().int().min(1).max(29),
  rollbackVersionsPerChannel: z.number().int().min(0).max(10),
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional(),
  testModeTtlMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1000).optional(),
  now: IsoDateSchema,
  quotaPressure: z.boolean(),
}).strict();


export const RetirementPolicySchema = z.object({
  rollbackVersionsPerChannel: z.number().int().min(0).max(20).default(2),
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional(),
}).strict();


export const GoldenSnapshotOperationalCursorSchema = z.object({
  createdAt: IsoDateSchema,
  snapshotId: UuidSchema,
}).strict();


export const OperationalStatusPageInputSchema = z.object({
  limit: z.number().int().min(1).max(100),
  cursor: GoldenSnapshotOperationalCursorSchema.optional(),
}).strict();


export const AffectedMachineCursorSchema = z.object({
  machineId: UuidSchema,
}).strict();


export const AffectedMachinePageInputSchema = z.object({
  limit: z.number().int().min(1).max(100),
  cursor: AffectedMachineCursorSchema.optional(),
}).strict();


export type GoldenSnapshotOperationalCursor = z.infer<typeof GoldenSnapshotOperationalCursorSchema>;


export type GoldenSnapshotAffectedMachineCursor = z.infer<typeof AffectedMachineCursorSchema>;


export interface GoldenSnapshotAffectedMachine {
  machineId: string;
  runtimeSlot: string;
  sourceSnapshotId: string;
  targetBundleVersion: string;
  status: string;
  updatedAt: string;
}


export function encodeGoldenSnapshotOperationalCursor(rawCursor: GoldenSnapshotOperationalCursor): string {
  const cursor = GoldenSnapshotOperationalCursorSchema.parse(rawCursor);
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}


export function decodeGoldenSnapshotOperationalCursor(rawCursor: string): GoldenSnapshotOperationalCursor {
  const cursor = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/).parse(rawCursor);
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.byteLength(decoded, 'utf8') > 256) throw new Error('Invalid snapshot status cursor');
  try {
    return GoldenSnapshotOperationalCursorSchema.parse(JSON.parse(decoded));
  } catch (err: unknown) {
    if (err instanceof SyntaxError || err instanceof z.ZodError) {
      throw new Error('Invalid snapshot status cursor');
    }
    throw err;
  }
}


export function encodeGoldenSnapshotAffectedMachineCursor(
  rawCursor: GoldenSnapshotAffectedMachineCursor,
): string {
  const cursor = AffectedMachineCursorSchema.parse(rawCursor);
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}


export function decodeGoldenSnapshotAffectedMachineCursor(
  rawCursor: string,
): GoldenSnapshotAffectedMachineCursor {
  const cursor = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/).parse(rawCursor);
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.byteLength(decoded, 'utf8') > 256) throw new Error('Invalid affected-machine cursor');
  try {
    return AffectedMachineCursorSchema.parse(JSON.parse(decoded));
  } catch (err: unknown) {
    if (err instanceof SyntaxError || err instanceof z.ZodError) {
      throw new Error('Invalid affected-machine cursor');
    }
    throw err;
  }
}


export const SnapshotRowSchema = z.object({
  snapshot_id: UuidSchema,
  bundle_version: GoldenSnapshotBundleVersionSchema,
  bundle_sha256: Sha256Schema,
  source_git_commit: z.string().min(1).max(128),
  compatibility_key: Sha256Schema,
  provider: z.literal('hetzner'),
  architecture: z.enum(['x86', 'arm']),
  region: z.string(),
  base_image: z.string(),
  base_generation: z.string(),
  boot_mode: z.enum(['bios', 'uefi']),
  activation_abi: z.string(),
  minimum_disk_gb: z.number().int().positive(),
  test_mode: z.boolean(),
  image_generation: z.number().int().positive(),
  state: GoldenSnapshotStateSchema,
  provider_image_id: z.coerce.number().int().positive().nullable(),
  provider_image_status: z.string().nullable(),
  image_disk_gb: z.number().int().positive().nullable(),
  image_architecture: z.enum(['x86', 'arm']).nullable(),
  validation_summary: GoldenSnapshotValidationSummarySchema.nullable(),
  failure_code: z.string().nullable(),
  ready_at: z.string().nullable(),
  quarantined_at: z.string().nullable(),
  retiring_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  revision: z.number().int().positive(),
});


export const BuildRowSchema = z.object({
  build_id: UuidSchema,
  snapshot_id: UuidSchema,
  phase: GoldenSnapshotBuildPhaseSchema,
  status: GoldenSnapshotBuildStatusSchema,
  attempts: z.number().int().nonnegative(),
  available_at: z.string(),
  claimed_at: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  callback_phase: z.string().nullable(),
  callback_token_hash: z.string().nullable(),
  callback_expires_at: z.string().nullable(),
  callback_event_id: UuidSchema.nullable(),
  callback_payload_sha256: Sha256Schema.nullable(),
  callback_outcome: z.unknown().nullable(),
  builder_machine_id_sha256: Sha256Schema.nullable(),
  builder_ssh_host_key_sha256: Sha256Schema.nullable(),
  validation_clone_ordinal: z.number().int().min(1).max(2),
  first_validation_machine_id_sha256: Sha256Schema.nullable(),
  first_validation_ssh_host_key_sha256: Sha256Schema.nullable(),
  provider_builder_id: z.coerce.number().int().positive().nullable(),
  provider_builder_action_id: z.coerce.number().int().positive().nullable(),
  provider_snapshot_action_id: z.coerce.number().int().positive().nullable(),
  provider_validation_id: z.coerce.number().int().positive().nullable(),
  provider_validation_action_id: z.coerce.number().int().positive().nullable(),
  pending_operation: z.string().nullable(),
  last_error_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});


export const LeaseRowSchema = z.object({
  lease_id: UuidSchema,
  snapshot_id: UuidSchema,
  machine_id: UuidSchema,
  purpose: z.enum(['provision', 'recover']),
  target_bundle_version: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  released_at: z.string().nullable(),
});


export const CreateIntentRowSchema = z.object({
  intent_id: UuidSchema,
  snapshot_id: UuidSchema,
  lease_id: UuidSchema,
  machine_id: UuidSchema,
  purpose: z.enum(['provision', 'recover']),
  rollout_generation: z.coerce.number().int().nonnegative(),
  state: z.enum(['pending', 'accepted', 'denied', 'activated', 'cleaned']),
  provider_create_action_id: z.coerce.number().int().positive().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});


export const RolloutControlRowSchema = z.object({
  compatibility_key: Sha256Schema,
  enabled: z.boolean(),
  percentage: z.coerce.number().int().min(0).max(100),
  generation: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updated_at: z.string(),
});


export const CleanupRowSchema = z.object({
  cleanup_id: UuidSchema,
  snapshot_id: UuidSchema.nullable(),
  build_id: UuidSchema.nullable(),
  resource_type: z.enum(['builder_server', 'validation_server', 'snapshot_image']),
  provider_resource_id: z.coerce.number().int().positive(),
  provenance_key: z.string(),
  reason: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'quarantined']),
  attempts: z.number().int().nonnegative(),
  next_attempt_at: z.string(),
  lease_expires_at: z.string().nullable(),
  last_error_code: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});


export type GoldenSnapshotRecord = ReturnType<typeof mapSnapshot>;


export type GoldenSnapshotBuildRecord = ReturnType<typeof mapBuild>;


export type GoldenSnapshotLeaseRecord = ReturnType<typeof mapLease>;


export type GoldenSnapshotCreateIntentRecord = ReturnType<typeof mapCreateIntent>;


export type GoldenSnapshotRolloutControlRecord = ReturnType<typeof mapRolloutControl>;


export type GoldenSnapshotCleanupRecord = ReturnType<typeof mapCleanup>;


export class GoldenSnapshotBuildRequiresRetryError extends Error {
  constructor() {
    super('Golden snapshot terminal build requires explicit retry or replacement');
    this.name = 'GoldenSnapshotBuildRequiresRetryError';
  }
}


export const EnqueueInputSchema = z.object({
  bundleVersion: GoldenSnapshotBundleVersionSchema,
  compatibility: GoldenSnapshotCompatibilitySchema,
  snapshotId: UuidSchema,
  buildId: UuidSchema,
  testMode: z.boolean().default(false),
  replaceReady: z.boolean().default(false),
  now: IsoDateSchema,
}).strict();


export const RegisteredReleaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());


export const ValidationReservationInputSchema = z.object({
  buildId: UuidSchema,
  validationOrdinal: z.number().int().min(1).max(2),
  callbackTokenHash: Sha256Schema,
  callbackExpiresAt: IsoDateSchema,
  now: IsoDateSchema,
  maxResources: z.number().int().min(1).max(10),
}).strict();


export const ProviderImageInputSchema = z.object({
  buildId: UuidSchema,
  expectedLeaseExpiresAt: IsoDateSchema,
  providerSnapshotActionId: z.number().int().positive().nullable().optional(),
  providerImageId: z.number().int().positive(),
  providerImageStatus: z.enum(['creating', 'available']),
  imageDiskGb: z.number().int().min(1).max(2_048),
  imageArchitecture: z.enum(['x86', 'arm']),
  now: IsoDateSchema,
}).strict();


export const SelectInputSchema = z.object({
  targetBundleVersion: z.string().min(1).max(128),
  compatibility: GoldenSnapshotCompatibilitySchema,
  serverDiskGb: z.number().int().min(1).max(2_048),
  machineId: UuidSchema,
  purpose: z.enum(['provision', 'recover']),
  leaseId: UuidSchema,
  now: IsoDateSchema,
  expiresAt: IsoDateSchema,
  maxLeaseMs: z.number().int().min(60_000).max(60 * 60 * 1000).default(10 * 60 * 1000),
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000)
    .default(DEFAULT_GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS),
  provisioningJobId: UuidSchema.optional(),
}).strict();
