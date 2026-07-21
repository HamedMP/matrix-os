import { createHash } from 'node:crypto';
import { z } from 'zod/v4';

const SAFE_COMPATIBILITY_VALUE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const GoldenSnapshotBaseGenerationSchema = z.string()
  .min(1)
  .max(64)
  .regex(SAFE_COMPATIBILITY_VALUE);

export const GoldenSnapshotStateSchema = z.enum([
  'candidate',
  'building',
  'sanitizing',
  'validating',
  'ready',
  'failed',
  'quarantined',
  'retiring',
  'deleted',
]);

export type GoldenSnapshotState = z.infer<typeof GoldenSnapshotStateSchema>;

export const GoldenSnapshotBuildStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export const GoldenSnapshotBuildPhaseSchema = z.enum([
  'requested',
  'builder_create',
  'builder_boot',
  'sanitizing',
  'snapshot_create',
  'snapshot_wait',
  'validation_create',
  'validation_boot',
  'cleanup',
  'completed',
  'failed',
  'reconciling',
]);

export const GoldenSnapshotCompatibilitySchema = z.object({
  provider: z.literal('hetzner'),
  architecture: z.enum(['x86', 'arm']),
  region: z.string().min(1).max(64).regex(SAFE_COMPATIBILITY_VALUE),
  baseImage: z.string().min(1).max(64).regex(SAFE_COMPATIBILITY_VALUE),
  baseGeneration: GoldenSnapshotBaseGenerationSchema,
  bootMode: z.enum(['bios', 'uefi']),
  activationAbi: z.string().min(1).max(64).regex(SAFE_COMPATIBILITY_VALUE),
  minimumDiskGb: z.number().int().min(1).max(2_048),
}).strict();

export type GoldenSnapshotCompatibility = z.infer<typeof GoldenSnapshotCompatibilitySchema>;

export const DEFAULT_GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const GoldenSnapshotRuntimeConfigSchema = z.object({
  enabled: z.boolean(),
  buildsEnabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  compatibility: GoldenSnapshotCompatibilitySchema,
  maxBuildAttempts: z.number().int().min(1).max(10),
  maxConcurrentBuilds: z.number().int().min(1).max(10),
  buildLeaseMs: z.number().int().min(60_000).max(30 * 60 * 1000),
  provisioningLeaseMs: z.number().int().min(60_000).max(30 * 60 * 1000),
  retentionLimit: z.number().int().min(1).max(29),
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000),
  testModeTtlMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1000),
  auditRetentionMs: z.number().int().min(24 * 60 * 60 * 1000).max(365 * 24 * 60 * 60 * 1000),
  reconciliationBatchSize: z.number().int().min(1).max(100),
}).strict();

export type GoldenSnapshotRuntimeConfig = z.infer<typeof GoldenSnapshotRuntimeConfigSchema>;

export const GoldenSnapshotValidationSummarySchema = z.object({
  exactBundle: z.literal(true),
  healthy: z.literal(true),
  freshActivation: z.literal(true),
  uniqueMachineId: z.literal(true),
  uniqueSshHostKey: z.literal(true),
  forbiddenStateAbsent: z.literal(true),
}).strict();

export type GoldenSnapshotValidationSummary = z.infer<typeof GoldenSnapshotValidationSummarySchema>;

const ALLOWED_TRANSITIONS: Record<GoldenSnapshotState, readonly GoldenSnapshotState[]> = {
  candidate: ['building', 'failed', 'quarantined', 'retiring'],
  building: ['sanitizing', 'failed', 'quarantined', 'retiring'],
  sanitizing: ['validating', 'failed', 'quarantined', 'retiring'],
  validating: ['ready', 'failed', 'quarantined', 'retiring'],
  ready: ['quarantined', 'retiring'],
  failed: ['quarantined', 'retiring'],
  quarantined: ['retiring'],
  retiring: ['deleted'],
  deleted: [],
};

export function canTransitionGoldenSnapshot(from: GoldenSnapshotState, to: GoldenSnapshotState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function compatibilityKey(input: GoldenSnapshotCompatibility): string {
  const parsed = GoldenSnapshotCompatibilitySchema.parse(input);
  const normalized = [
    parsed.provider,
    parsed.architecture,
    parsed.region,
    parsed.baseImage,
    parsed.baseGeneration,
    parsed.bootMode,
    parsed.activationAbi,
    String(parsed.minimumDiskGb),
  ].join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}
