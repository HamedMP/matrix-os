import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import { releaseGoldenSnapshotLease, selectAndLeaseGoldenSnapshot } from './golden-snapshot-repository.js';
import { GoldenSnapshotRuntimeConfigSchema, type GoldenSnapshotRuntimeConfig } from './golden-snapshot-schema.js';

const ServerProfiles: Record<string, { architecture: 'x86' | 'arm'; diskGb: number }> = {
  cpx22: { architecture: 'x86', diskGb: 80 },
  cpx32: { architecture: 'x86', diskGb: 160 },
  cpx52: { architecture: 'x86', diskGb: 320 },
  cax21: { architecture: 'arm', diskGb: 80 },
  cax31: { architecture: 'arm', diskGb: 160 },
  cax41: { architecture: 'arm', diskGb: 320 },
};

const SelectionInputSchema = z.object({
  jobId: z.string().uuid(),
  machineId: z.string().uuid(),
  targetBundleVersion: z.string().min(1).max(128),
  serverType: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  purpose: z.enum(['provision', 'recover']),
  leaseId: z.string().uuid(),
  now: z.string().datetime({ offset: true }),
}).strict();

const FallbackInputSchema = z.object({
  jobId: z.string().uuid(),
  reason: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/),
  now: z.string().datetime({ offset: true }),
}).strict();

const RecoverySelectionInputSchema = SelectionInputSchema.omit({ jobId: true }).extend({
  purpose: z.literal('recover'),
}).strict();

export type ProvisioningImageDecision =
  | { imageSource: 'clean_image'; targetBundleVersion: string; targetBundleSha256: string }
  | {
      imageSource: 'snapshot';
      targetBundleVersion: string;
      targetBundleSha256: string;
      snapshotId: string;
      snapshotLeaseId: string;
      providerImageId: number;
      sourceBundleVersion: string;
      sourceBaseGeneration: string;
      exact: boolean;
      requiresExactUpdate: boolean;
    };

function includedInRollout(machineId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const bucket = createHash('sha256').update(machineId).digest().readUInt32BE(0) % 100;
  return bucket < percent;
}

async function persistCleanDecision(
  db: PlatformDB,
  input: z.infer<typeof SelectionInputSchema>,
  targetSha256: string,
): Promise<ProvisioningImageDecision> {
  const row = await db.executor.updateTable('provisioning_jobs').set({
    target_bundle_version: input.targetBundleVersion,
    target_bundle_sha256: targetSha256,
    image_source: 'clean_image',
    snapshot_id: null,
    snapshot_lease_id: null,
    activation_step: 'creating',
    fallback_reason: null,
    updated_at: input.now,
  }).where('job_id', '=', input.jobId).where('machine_id', '=', input.machineId)
    .where('status', '=', 'running').returning('job_id').executeTakeFirst();
  if (!row) throw new Error('Provisioning job lost before image decision');
  return {
    imageSource: 'clean_image',
    targetBundleVersion: input.targetBundleVersion,
    targetBundleSha256: targetSha256,
  };
}

export async function chooseProvisioningImage(
  db: PlatformDB,
  rawConfig: GoldenSnapshotRuntimeConfig,
  rawInput: z.input<typeof SelectionInputSchema>,
): Promise<ProvisioningImageDecision> {
  const config = GoldenSnapshotRuntimeConfigSchema.parse(rawConfig);
  const input = SelectionInputSchema.parse(rawInput);
  await db.ready;
  const target = await db.executor.selectFrom('host_bundle_releases').select(['sha256'])
    .where('version', '=', input.targetBundleVersion).executeTakeFirst();
  const profile = ServerProfiles[input.serverType];
  if (!config.enabled || !includedInRollout(input.machineId, config.rolloutPercent)
    || !profile || profile.architecture !== config.compatibility.architecture || !target) {
    return persistCleanDecision(db, input, target?.sha256 ?? '0'.repeat(64));
  }
  const selected = await selectAndLeaseGoldenSnapshot(db, {
    targetBundleVersion: input.targetBundleVersion,
    compatibility: config.compatibility,
    serverDiskGb: profile.diskGb,
    machineId: input.machineId,
    purpose: input.purpose,
    leaseId: input.leaseId,
    now: input.now,
    expiresAt: new Date(new Date(input.now).getTime() + config.provisioningLeaseMs).toISOString(),
    freshnessMaxAgeMs: config.freshnessMaxAgeMs,
    provisioningJobId: input.jobId,
  });
  if (!selected || selected.snapshot.providerImageId === null) {
    return persistCleanDecision(db, input, target.sha256);
  }
  const exact = selected.snapshot.bundleSha256 === target.sha256;
  return {
    imageSource: 'snapshot',
    targetBundleVersion: input.targetBundleVersion,
    targetBundleSha256: target.sha256,
    snapshotId: selected.snapshot.snapshotId,
    snapshotLeaseId: selected.lease.leaseId,
    providerImageId: selected.snapshot.providerImageId,
    sourceBundleVersion: selected.snapshot.bundleVersion,
    sourceBaseGeneration: selected.snapshot.compatibility.baseGeneration,
    exact,
    requiresExactUpdate: !exact,
  };
}

export async function fallbackProvisioningImage(
  db: PlatformDB,
  rawInput: z.input<typeof FallbackInputSchema>,
): Promise<boolean> {
  const input = FallbackInputSchema.parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    const job = await trx.executor.selectFrom('provisioning_jobs').selectAll()
      .where('job_id', '=', input.jobId).where('status', '=', 'running').forUpdate().executeTakeFirst();
    if (!job) return false;
    if (job.snapshot_lease_id) await releaseGoldenSnapshotLease(trx, job.snapshot_lease_id, input.now);
    const updated = await trx.executor.updateTable('provisioning_jobs').set({
      image_source: 'clean_image', snapshot_id: null, snapshot_lease_id: null,
      provider_create_action_id: null, activation_step: 'fallback_pending',
      fallback_reason: input.reason, updated_at: input.now,
    }).where('job_id', '=', input.jobId).where('status', '=', 'running').returning('job_id').executeTakeFirst();
    return updated !== undefined;
  });
}

export async function chooseRecoveryImage(
  db: PlatformDB,
  rawConfig: GoldenSnapshotRuntimeConfig,
  rawInput: z.input<typeof RecoverySelectionInputSchema>,
): Promise<ProvisioningImageDecision> {
  const config = GoldenSnapshotRuntimeConfigSchema.parse(rawConfig);
  const input = RecoverySelectionInputSchema.parse(rawInput);
  await db.ready;
  const target = await db.executor.selectFrom('host_bundle_releases').select('sha256')
    .where('version', '=', input.targetBundleVersion).executeTakeFirst();
  const profile = ServerProfiles[input.serverType];
  if (!config.enabled || !includedInRollout(input.machineId, config.rolloutPercent)
    || !profile || profile.architecture !== config.compatibility.architecture || !target) {
    return {
      imageSource: 'clean_image', targetBundleVersion: input.targetBundleVersion,
      targetBundleSha256: target?.sha256 ?? '0'.repeat(64),
    };
  }
  const selected = await selectAndLeaseGoldenSnapshot(db, {
    targetBundleVersion: input.targetBundleVersion,
    compatibility: config.compatibility,
    serverDiskGb: profile.diskGb,
    machineId: input.machineId,
    purpose: 'recover',
    leaseId: input.leaseId,
    now: input.now,
    expiresAt: new Date(new Date(input.now).getTime() + config.provisioningLeaseMs).toISOString(),
    freshnessMaxAgeMs: config.freshnessMaxAgeMs,
  });
  if (!selected?.snapshot.providerImageId) {
    return { imageSource: 'clean_image', targetBundleVersion: input.targetBundleVersion, targetBundleSha256: target.sha256 };
  }
  const exact = selected.snapshot.bundleSha256 === target.sha256;
  return {
    imageSource: 'snapshot', targetBundleVersion: input.targetBundleVersion, targetBundleSha256: target.sha256,
    snapshotId: selected.snapshot.snapshotId, snapshotLeaseId: selected.lease.leaseId,
    providerImageId: selected.snapshot.providerImageId, sourceBundleVersion: selected.snapshot.bundleVersion,
    sourceBaseGeneration: selected.snapshot.compatibility.baseGeneration,
    exact, requiresExactUpdate: !exact,
  };
}
