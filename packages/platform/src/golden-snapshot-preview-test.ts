import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB, UserMachineRecord } from './db.js';
import type { ProvisioningJobRecord } from './customer-vps-provisioning-jobs.js';
import {
  CustomerVpsError,
  PreviewSnapshotUnavailableError,
  type PreviewSnapshotUnavailableReason,
} from './customer-vps-errors.js';
import {
  fallbackProvisioningImage,
  getGoldenSnapshotServerProfile,
  resolveGoldenSnapshotRollout,
  type ProvisioningImageDecision,
} from './golden-snapshot-activation.js';
import {
  getGoldenSnapshot,
  type GoldenSnapshotRecord,
} from './golden-snapshot-repository.js';
import {
  compatibilityKey,
  GoldenSnapshotBundleVersionSchema,
  GoldenSnapshotRuntimeConfigSchema,
  type GoldenSnapshotRuntimeConfig,
} from './golden-snapshot-schema.js';

const UuidSchema = z.uuid();
const IsoDateSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const CreateIntentStateSchema = z.enum(['pending', 'accepted', 'denied', 'activated', 'cleaned']);

const BindInputSchema = z.object({
  snapshotId: UuidSchema,
  targetBundleVersion: GoldenSnapshotBundleVersionSchema,
  serverType: z.string().min(1).max(64),
  machineId: UuidSchema,
  provisioningJobId: UuidSchema,
  now: IsoDateSchema,
}).strict();

function persistedSnapshotUnavailableReason(input: {
  snapshot: GoldenSnapshotRecord | undefined;
  isPreviewTestSnapshot: boolean;
  imageVersion: string;
  targetBundleSha256: string | null;
  freshnessCutoff: string;
}): PreviewSnapshotUnavailableReason | undefined {
  const { snapshot } = input;
  if (!snapshot) return 'persisted_snapshot_missing';
  if (snapshot.providerImageId === null) return 'persisted_provider_image_missing';
  if (snapshot.providerImageStatus !== 'available') return 'persisted_provider_image_unavailable';
  if (snapshot.state !== 'ready') return 'persisted_snapshot_not_ready';
  if (!snapshot.readyAt) return 'persisted_snapshot_ready_at_missing';
  if (snapshot.readyAt <= input.freshnessCutoff) return 'persisted_snapshot_stale';
  if (input.isPreviewTestSnapshot && snapshot.bundleVersion !== input.imageVersion) {
    return 'persisted_bundle_version_mismatch';
  }
  if (input.isPreviewTestSnapshot && snapshot.bundleSha256 !== input.targetBundleSha256) {
    return 'persisted_bundle_digest_mismatch';
  }
  return undefined;
}

export async function resolvePreviewTestSnapshotBundle(
  db: PlatformDB,
  rawSnapshotId: string,
): Promise<{ bundleVersion: string; bundleSha256: string } | undefined> {
  // This read only chooses the immutable bundle for cloud-init. The binding
  // transaction below repeats every snapshot, release, and compatibility
  // check before it commits the machine, job, and lease together.
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  const snapshot = await getGoldenSnapshot(db, snapshotId);
  if (!snapshot?.testMode) return undefined;
  const release = await db.executor.selectFrom('host_bundle_releases')
    .select('sha256')
    .where('version', '=', snapshot.bundleVersion)
    .executeTakeFirst();
  if (release?.sha256.toLowerCase() !== snapshot.bundleSha256) return undefined;
  return {
    bundleVersion: snapshot.bundleVersion,
    bundleSha256: snapshot.bundleSha256,
  };
}

export function isPreviewTestSnapshotDecision(
  decision: ProvisioningImageDecision,
): decision is Extract<ProvisioningImageDecision, { imageSource: 'snapshot' }> & { previewTest: true } {
  return decision.imageSource === 'snapshot' && decision.previewTest === true;
}

export async function resolvePersistedProvisioningImage(input: {
  db: PlatformDB;
  config: GoldenSnapshotRuntimeConfig;
  machine: UserMachineRecord;
  job: ProvisioningJobRecord;
  imageVersion: string;
  claimedAt: Date;
}): Promise<{
  imageDecision: ProvisioningImageDecision;
  transitionedToFallback: boolean;
  effectiveProviderCreateActionId: number | null;
}> {
  const config = GoldenSnapshotRuntimeConfigSchema.parse(input.config);
  const { db, machine, job, imageVersion, claimedAt } = input;
  if (job.imageSource !== 'snapshot' || !job.snapshotId || !job.snapshotLeaseId) {
    throw new Error('Persisted snapshot decision is incomplete');
  }
  const persistedSnapshot = await getGoldenSnapshot(db, job.snapshotId);
  const isPreviewTestSnapshot = machine.provisioningClass === 'preview'
    && persistedSnapshot?.testMode === true;
  const rollout = isPreviewTestSnapshot
    ? { included: false, generation: 0 }
    : await resolveGoldenSnapshotRollout(db, config, machine.machineId, claimedAt.toISOString());
  const freshnessMaxAgeMs = isPreviewTestSnapshot
    ? Math.min(config.freshnessMaxAgeMs, config.testModeTtlMs)
    : config.freshnessMaxAgeMs;
  const freshnessCutoff = new Date(claimedAt.getTime() - freshnessMaxAgeMs).toISOString();
  const unavailableReason = persistedSnapshotUnavailableReason({
    snapshot: persistedSnapshot,
    isPreviewTestSnapshot,
    imageVersion,
    targetBundleSha256: job.targetBundleSha256,
    freshnessCutoff,
  });
  const unavailable = unavailableReason !== undefined;
  if ((!rollout.included && !isPreviewTestSnapshot) || unavailable) {
    if (isPreviewTestSnapshot) {
      throw new PreviewSnapshotUnavailableError(unavailableReason ?? 'persisted_snapshot_not_ready');
    }
    await fallbackProvisioningImage(db, {
      jobId: job.jobId,
      reason: !rollout.included
        ? 'snapshot_rollout_disabled'
        : persistedSnapshot?.state === 'ready' ? 'snapshot_stale' : 'snapshot_unavailable',
      now: claimedAt.toISOString(),
    });
    return {
      imageDecision: {
        imageSource: 'clean_image',
        targetBundleVersion: imageVersion,
        targetBundleSha256: job.targetBundleSha256 ?? '0'.repeat(64),
      },
      transitionedToFallback: true,
      effectiveProviderCreateActionId: null,
    };
  }
  if (!persistedSnapshot) {
    throw new Error('Persisted snapshot resolution invariant failed');
  }
  const providerImageId = persistedSnapshot.providerImageId;
  if (providerImageId === null) {
    throw new PreviewSnapshotUnavailableError('persisted_provider_image_missing');
  }
  return {
    imageDecision: {
      imageSource: 'snapshot',
      targetBundleVersion: imageVersion,
      targetBundleSha256: job.targetBundleSha256 ?? persistedSnapshot.bundleSha256,
      snapshotId: persistedSnapshot.snapshotId,
      snapshotLeaseId: job.snapshotLeaseId,
      providerImageId,
      sourceBundleVersion: persistedSnapshot.bundleVersion,
      sourceBaseGeneration: persistedSnapshot.compatibility.baseGeneration,
      rolloutGeneration: isPreviewTestSnapshot ? 0 : rollout.generation,
      ...(isPreviewTestSnapshot ? { previewTest: true as const } : {}),
      exact: persistedSnapshot.bundleSha256 === job.targetBundleSha256,
      requiresExactUpdate: persistedSnapshot.bundleSha256 !== job.targetBundleSha256,
    },
    transitionedToFallback: false,
    effectiveProviderCreateActionId: job.providerCreateActionId,
  };
}

/**
 * Bind one operator-requested test image to one preview job. This is called
 * inside the machine+job creation transaction, and repeats the preview-class
 * check in SQL so ordinary customer jobs cannot gain this capability.
 */
export async function bindTestSnapshotToPreviewProvisionInTransaction(
  trx: PlatformDB,
  rawInput: z.input<typeof BindInputSchema>,
  rawConfig: GoldenSnapshotRuntimeConfig,
): Promise<boolean> {
  const input = BindInputSchema.parse(rawInput);
  const config = GoldenSnapshotRuntimeConfigSchema.parse(rawConfig);
  const profile = getGoldenSnapshotServerProfile(input.serverType);
  if (!profile || profile.architecture !== config.compatibility.architecture) return false;
  const now = input.now;
  const expiresAt = new Date(Date.parse(now) + config.provisioningLeaseMs).toISOString();
  const identity = await trx.executor.selectFrom('golden_snapshots')
    .select(['base_generation', 'compatibility_key'])
    .where('snapshot_id', '=', input.snapshotId).executeTakeFirst();
  if (!identity) return false;
  await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.base_generation}))`.execute(trx.executor);
  await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.compatibility_key}))`.execute(trx.executor);
  const previewJob = await trx.executor.selectFrom('provisioning_jobs')
    .innerJoin('user_machines', 'user_machines.machine_id', 'provisioning_jobs.machine_id')
    .select('provisioning_jobs.job_id')
    .where('provisioning_jobs.job_id', '=', input.provisioningJobId)
    .where('provisioning_jobs.machine_id', '=', input.machineId)
    .where('provisioning_jobs.status', '=', 'queued')
    .where('user_machines.provisioning_class', '=', 'preview')
    .where('user_machines.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!previewJob) return false;
  const snapshot = await trx.executor.selectFrom('golden_snapshots').select([
    'snapshot_id', 'bundle_version', 'bundle_sha256', 'compatibility_key', 'architecture',
    'activation_abi', 'minimum_disk_gb', 'image_disk_gb', 'test_mode', 'state',
    'provider_image_id', 'provider_image_status', 'ready_at', 'base_generation',
  ]).where('snapshot_id', '=', input.snapshotId).forUpdate().executeTakeFirst();
  if (!snapshot) return false;
  const release = await trx.executor.selectFrom('host_bundle_releases').select('sha256')
    .where('version', '=', input.targetBundleVersion).executeTakeFirst();
  const revoked = await trx.executor.selectFrom('golden_snapshot_revoked_base_generations')
    .select('base_generation').where('base_generation', '=', snapshot.base_generation).executeTakeFirst();
  const freshnessCutoff = new Date(
    Date.parse(now) - Math.min(config.freshnessMaxAgeMs, config.testModeTtlMs),
  ).toISOString();
  const selectable = snapshot.test_mode
    && snapshot.state === 'ready'
    && snapshot.provider_image_id !== null
    && snapshot.provider_image_status === 'available'
    && snapshot.ready_at !== null
    && snapshot.ready_at > freshnessCutoff
    && snapshot.compatibility_key === compatibilityKey(config.compatibility)
    && snapshot.architecture === config.compatibility.architecture
    && snapshot.activation_abi === config.compatibility.activationAbi
    && snapshot.minimum_disk_gb <= profile.diskGb
    && (snapshot.image_disk_gb === null || snapshot.image_disk_gb <= profile.diskGb)
    && snapshot.bundle_version === input.targetBundleVersion
    && release?.sha256.toLowerCase() === snapshot.bundle_sha256
    && revoked === undefined;
  if (!selectable) return false;
  const leaseId = randomUUID();
  const lease = await trx.executor.insertInto('golden_snapshot_leases').values({
    lease_id: leaseId,
    snapshot_id: snapshot.snapshot_id,
    machine_id: input.machineId,
    purpose: 'provision',
    target_bundle_version: input.targetBundleVersion,
    created_at: now,
    expires_at: expiresAt,
    released_at: null,
  }).onConflict((oc) => oc.column('machine_id').where('released_at', 'is', null).doNothing())
    .returning('lease_id').executeTakeFirst();
  if (!lease) return false;
  const linked = await trx.executor.updateTable('provisioning_jobs').set({
    target_bundle_version: input.targetBundleVersion,
    target_bundle_sha256: snapshot.bundle_sha256,
    image_source: 'snapshot',
    snapshot_id: snapshot.snapshot_id,
    snapshot_lease_id: leaseId,
    activation_step: 'creating',
    fallback_reason: null,
    updated_at: now,
  }).where('job_id', '=', input.provisioningJobId)
    .where('machine_id', '=', input.machineId)
    .where('status', '=', 'queued')
    .returning('job_id').executeTakeFirst();
  if (!linked) throw new Error('Preview provisioning job lost before test snapshot lease commit');
  await trx.executor.insertInto('golden_snapshot_audit_events').values({
    event_id: randomUUID(),
    snapshot_id: snapshot.snapshot_id,
    build_id: null,
    cleanup_id: null,
    event_type: 'snapshot_test_provision_leased',
    actor_type: 'operator',
    actor_id_hash: null,
    from_state: null,
    to_state: null,
    reason: null,
    created_at: now,
  }).execute();
  return true;
}

const CreateIntentInputSchema = z.object({
  intentId: UuidSchema,
  snapshotId: UuidSchema,
  leaseId: UuidSchema,
  machineId: UuidSchema,
  providerImageId: z.number().int().positive(),
  now: IsoDateSchema,
}).strict();

export async function createPreviewTestSnapshotCreateIntent(
  db: PlatformDB,
  rawInput: z.input<typeof CreateIntentInputSchema>,
): Promise<{ state: z.infer<typeof CreateIntentStateSchema> } | undefined> {
  const input = CreateIntentInputSchema.parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    const identity = await trx.executor.selectFrom('golden_snapshots')
      .select(['base_generation', 'compatibility_key'])
      .where('snapshot_id', '=', input.snapshotId).executeTakeFirst();
    if (!identity) return undefined;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.base_generation}))`.execute(trx.executor);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.compatibility_key}))`.execute(trx.executor);
    const snapshot = await trx.executor.selectFrom('golden_snapshots').select([
      'snapshot_id', 'bundle_version', 'bundle_sha256', 'test_mode', 'state',
      'provider_image_id', 'provider_image_status', 'base_generation',
    ]).where('snapshot_id', '=', input.snapshotId).forUpdate().executeTakeFirst();
    if (!snapshot || !snapshot.test_mode || snapshot.state !== 'ready'
      || snapshot.provider_image_id !== input.providerImageId
      || snapshot.provider_image_status !== 'available') return undefined;
    const revoked = await trx.executor.selectFrom('golden_snapshot_revoked_base_generations')
      .select('base_generation').where('base_generation', '=', snapshot.base_generation).executeTakeFirst();
    if (revoked) return undefined;
    const previewJob = await trx.executor.selectFrom('provisioning_jobs')
      .innerJoin('user_machines', 'user_machines.machine_id', 'provisioning_jobs.machine_id')
      .select(['provisioning_jobs.target_bundle_version', 'provisioning_jobs.target_bundle_sha256'])
      .where('provisioning_jobs.machine_id', '=', input.machineId)
      .where('provisioning_jobs.snapshot_id', '=', input.snapshotId)
      .where('provisioning_jobs.snapshot_lease_id', '=', input.leaseId)
      .where('provisioning_jobs.image_source', '=', 'snapshot')
      .where('provisioning_jobs.status', '=', 'running')
      .where('user_machines.provisioning_class', '=', 'preview')
      .where('user_machines.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!previewJob || previewJob.target_bundle_version !== snapshot.bundle_version
      || previewJob.target_bundle_sha256 !== snapshot.bundle_sha256) return undefined;
    const lease = await trx.executor.selectFrom('golden_snapshot_leases').selectAll()
      .where('lease_id', '=', input.leaseId).forUpdate().executeTakeFirst();
    if (!lease || lease.released_at !== null || lease.snapshot_id !== input.snapshotId
      || lease.machine_id !== input.machineId || lease.purpose !== 'provision'
      || lease.target_bundle_version !== snapshot.bundle_version) return undefined;
    await trx.executor.insertInto('golden_snapshot_create_intents').values({
      intent_id: input.intentId,
      snapshot_id: input.snapshotId,
      lease_id: input.leaseId,
      machine_id: input.machineId,
      purpose: 'provision',
      rollout_generation: 0,
      state: 'pending',
      provider_create_action_id: null,
      created_at: input.now,
      updated_at: input.now,
      completed_at: null,
    }).onConflict((oc) => oc.column('lease_id').doNothing()).execute();
    const intent = await trx.executor.selectFrom('golden_snapshot_create_intents')
      .select(['intent_id', 'snapshot_id', 'machine_id', 'state', 'rollout_generation'])
      .where('lease_id', '=', input.leaseId).executeTakeFirstOrThrow();
    if (intent.snapshot_id !== input.snapshotId || intent.machine_id !== input.machineId
      || Number(intent.rollout_generation) !== 0) {
      throw new Error('Preview-test snapshot create intent provenance conflict');
    }
    const linked = await trx.executor.updateTable('provisioning_jobs').set({
      snapshot_create_intent_id: intent.intent_id,
      updated_at: input.now,
    }).where('snapshot_lease_id', '=', input.leaseId)
      .where((eb) => eb.or([
        eb('snapshot_create_intent_id', 'is', null),
        eb('snapshot_create_intent_id', '=', intent.intent_id),
      ])).returning('job_id').executeTakeFirst();
    if (!linked) throw new Error('Preview-test snapshot intent linkage failed');
    return { state: CreateIntentStateSchema.parse(intent.state) };
  });
}
