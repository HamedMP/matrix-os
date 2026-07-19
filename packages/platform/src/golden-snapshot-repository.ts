import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
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
} from './golden-snapshot-schema.js';
import { chooseGoldenSnapshot } from './golden-snapshot-selection.js';

const UuidSchema = z.string().uuid();
const IsoDateSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BoundedCodeSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
// Status is projected onto every accepted host-bundle release, including
// legacy/non-eligible names that can never identify a snapshot build.
const HostBundleStatusVersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const RetentionInputSchema = z.object({
  retentionLimit: z.number().int().min(1).max(29),
  rollbackVersionsPerChannel: z.number().int().min(0).max(10),
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional(),
  now: IsoDateSchema,
  quotaPressure: z.boolean(),
}).strict();
const RetirementPolicySchema = z.object({
  rollbackVersionsPerChannel: z.number().int().min(0).max(20).default(2),
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional(),
}).strict();

const SnapshotRowSchema = z.object({
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

const BuildRowSchema = z.object({
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

const LeaseRowSchema = z.object({
  lease_id: UuidSchema,
  snapshot_id: UuidSchema,
  machine_id: UuidSchema,
  purpose: z.enum(['provision', 'recover']),
  target_bundle_version: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  released_at: z.string().nullable(),
});

const CreateIntentRowSchema = z.object({
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

const CleanupRowSchema = z.object({
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
export type GoldenSnapshotCleanupRecord = ReturnType<typeof mapCleanup>;
export type GoldenSnapshotCoarseStatus = 'not_requested' | 'requested' | 'building' | 'ready' | 'failed' | 'unavailable';

export class GoldenSnapshotBuildRequiresRetryError extends Error {
  constructor() {
    super('Golden snapshot terminal build requires explicit retry or replacement');
    this.name = 'GoldenSnapshotBuildRequiresRetryError';
  }
}

function mapSnapshot(input: unknown) {
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

function mapBuild(input: unknown) {
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

function mapLease(input: unknown) {
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

function mapCreateIntent(input: unknown) {
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

function mapCleanup(input: unknown) {
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

type AuditActor = 'release' | 'worker' | 'operator';

export async function appendGoldenSnapshotAuditEvent(
  trx: PlatformDB,
  input: {
    snapshotId?: string | null;
    buildId?: string | null;
    cleanupId?: string | null;
    eventType: string;
    actorType: AuditActor;
    fromState?: string | null;
    toState?: string | null;
    reason?: string | null;
    now: string;
  },
): Promise<void> {
  await trx.executor.insertInto('golden_snapshot_audit_events').values({
    event_id: randomUUID(),
    snapshot_id: input.snapshotId ?? null,
    build_id: input.buildId ?? null,
    cleanup_id: input.cleanupId ?? null,
    event_type: BoundedCodeSchema.parse(input.eventType),
    actor_type: input.actorType,
    actor_id_hash: null,
    from_state: input.fromState ?? null,
    to_state: input.toState ?? null,
    reason: input.reason === undefined || input.reason === null
      ? null
      : BoundedCodeSchema.parse(input.reason),
    created_at: IsoDateSchema.parse(input.now),
  }).execute();
}

const EnqueueInputSchema = z.object({
  bundleVersion: GoldenSnapshotBundleVersionSchema,
  compatibility: GoldenSnapshotCompatibilitySchema,
  snapshotId: UuidSchema,
  buildId: UuidSchema,
  testMode: z.boolean().default(false),
  now: IsoDateSchema,
}).strict();

const RegisteredReleaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());

export async function enqueueGoldenSnapshotBuild(
  db: PlatformDB,
  rawInput: z.input<typeof EnqueueInputSchema>,
): Promise<{ snapshot: GoldenSnapshotRecord; build: GoldenSnapshotBuildRecord; reused: boolean }> {
  const input = EnqueueInputSchema.parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.compatibility.baseGeneration}))`.execute(trx.executor);
    const revokedGeneration = await trx.executor.selectFrom('golden_snapshot_revoked_base_generations')
      .select('base_generation').where('base_generation', '=', input.compatibility.baseGeneration)
      .executeTakeFirst();
    if (revokedGeneration) throw new Error('Base generation is revoked');
    const release = await trx.executor.selectFrom('host_bundle_releases')
      .select(['version', 'sha256', 'git_commit'])
      .where('version', '=', input.bundleVersion)
      .executeTakeFirstOrThrow();
    const bundleSha256 = RegisteredReleaseSha256Schema.parse(release.sha256);
    const key = compatibilityKey(input.compatibility);
    const insertedSnapshot = await trx.executor.insertInto('golden_snapshots').values({
      snapshot_id: input.snapshotId,
      bundle_version: release.version,
      bundle_sha256: bundleSha256,
      source_git_commit: release.git_commit,
      compatibility_key: key,
      provider: input.compatibility.provider,
      architecture: input.compatibility.architecture,
      region: input.compatibility.region,
      base_image: input.compatibility.baseImage,
      base_generation: input.compatibility.baseGeneration,
      boot_mode: input.compatibility.bootMode,
      activation_abi: input.compatibility.activationAbi,
      minimum_disk_gb: input.compatibility.minimumDiskGb,
      test_mode: input.testMode,
      state: 'candidate',
      provider_image_id: null,
      provider_image_status: null,
      image_disk_gb: null,
      image_architecture: null,
      validation_summary: null,
      failure_code: null,
      ready_at: null,
      quarantined_at: null,
      retiring_at: null,
      deleted_at: null,
      created_at: input.now,
      updated_at: input.now,
      revision: 1,
    }).onConflict((oc) => oc.columns(['bundle_sha256', 'compatibility_key', 'test_mode']).doNothing())
      .returningAll().executeTakeFirst();
    const snapshotRow = insertedSnapshot ?? await trx.executor.selectFrom('golden_snapshots')
      .selectAll().where('bundle_sha256', '=', bundleSha256).where('compatibility_key', '=', key)
      .where('test_mode', '=', input.testMode)
      .executeTakeFirstOrThrow();
    const snapshot = mapSnapshot(snapshotRow);
    if (snapshot.bundleVersion !== release.version) {
      throw new Error('Golden snapshot immutable provenance conflict');
    }
    const insertedBuild = await trx.executor.insertInto('golden_snapshot_builds').values({
      build_id: input.buildId,
      snapshot_id: snapshot.snapshotId,
      phase: 'requested',
      status: 'queued',
      attempts: 0,
      available_at: input.now,
      claimed_at: null,
      lease_expires_at: null,
      callback_phase: null,
      callback_token_hash: null,
      callback_expires_at: null,
      callback_event_id: null,
      callback_payload_sha256: null,
      callback_outcome: null,
      builder_machine_id_sha256: null,
      builder_ssh_host_key_sha256: null,
      validation_clone_ordinal: 1,
      first_validation_machine_id_sha256: null,
      first_validation_ssh_host_key_sha256: null,
      provider_builder_id: null,
      provider_builder_action_id: null,
      provider_snapshot_action_id: null,
      provider_validation_id: null,
      provider_validation_action_id: null,
      pending_operation: null,
      last_error_code: null,
      created_at: input.now,
      updated_at: input.now,
      completed_at: null,
    }).onConflict((oc) => oc.column('snapshot_id').doNothing()).returningAll().executeTakeFirst();
    const buildRow = insertedBuild ?? await trx.executor.selectFrom('golden_snapshot_builds')
      .selectAll().where('snapshot_id', '=', snapshot.snapshotId).executeTakeFirstOrThrow();
    const build = mapBuild(buildRow);
    if (!insertedBuild && (build.status === 'failed'
      || ['failed', 'quarantined', 'retiring', 'deleted'].includes(snapshot.state))) {
      throw new GoldenSnapshotBuildRequiresRetryError();
    }
    if (insertedBuild) {
      await appendGoldenSnapshotAuditEvent(trx, {
        snapshotId: snapshot.snapshotId,
        buildId: buildRow.build_id,
        eventType: 'build_enqueued',
        actorType: 'release',
        toState: 'candidate',
        now: input.now,
      });
    }
    return { snapshot, build, reused: insertedSnapshot === undefined };
  });
}

export async function getGoldenSnapshot(db: PlatformDB, rawSnapshotId: string): Promise<GoldenSnapshotRecord | undefined> {
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  await db.ready;
  const row = await db.executor.selectFrom('golden_snapshots').selectAll().where('snapshot_id', '=', snapshotId).executeTakeFirst();
  return row ? mapSnapshot(row) : undefined;
}

export async function getGoldenSnapshotCoarseStatus(
  db: PlatformDB,
  rawBundleVersion: string,
  rawCompatibility?: GoldenSnapshotCompatibility,
): Promise<GoldenSnapshotCoarseStatus> {
  const bundleVersion = HostBundleStatusVersionSchema.parse(rawBundleVersion);
  return (await getGoldenSnapshotCoarseStatuses(db, [bundleVersion], rawCompatibility))
    .get(bundleVersion) ?? 'not_requested';
}

function coarseStatus(states: GoldenSnapshotState[]): GoldenSnapshotCoarseStatus {
  if (states.includes('ready')) return 'ready';
  if (states.some((state) => state === 'building' || state === 'sanitizing' || state === 'validating')) return 'building';
  if (states.includes('candidate')) return 'requested';
  if (states.some((state) => state === 'failed' || state === 'quarantined')) return 'failed';
  if (states.some((state) => state === 'retiring' || state === 'deleted')) return 'unavailable';
  return 'not_requested';
}

export async function getGoldenSnapshotCoarseStatuses(
  db: PlatformDB,
  rawBundleVersions: string[],
  rawCompatibility?: GoldenSnapshotCompatibility,
): Promise<Map<string, GoldenSnapshotCoarseStatus>> {
  const bundleVersions = z.array(HostBundleStatusVersionSchema).max(100)
    .transform((versions) => [...new Set(versions)]).parse(rawBundleVersions);
  const activeCompatibilityKey = rawCompatibility === undefined
    ? undefined
    : compatibilityKey(GoldenSnapshotCompatibilitySchema.parse(rawCompatibility));
  await db.ready;
  const result = new Map<string, GoldenSnapshotCoarseStatus>(
    bundleVersions.map((version) => [version, 'not_requested']),
  );
  if (bundleVersions.length === 0) return result;
  let query = db.executor.selectFrom('golden_snapshots')
    .select(['bundle_version', 'state'])
    .where('bundle_version', 'in', bundleVersions)
    .where('test_mode', '=', false);
  if (activeCompatibilityKey !== undefined) {
    query = query.where('compatibility_key', '=', activeCompatibilityKey);
  }
  const rows = await query
    .groupBy(['bundle_version', 'state'])
    .execute();
  const grouped = new Map<string, GoldenSnapshotState[]>();
  for (const row of rows) {
    const states = grouped.get(row.bundle_version) ?? [];
    states.push(GoldenSnapshotStateSchema.parse(row.state));
    grouped.set(row.bundle_version, states);
  }
  for (const [version, states] of grouped) result.set(version, coarseStatus(states));
  return result;
}

const MissingBuildReconciliationInputSchema = z.object({
  compatibility: GoldenSnapshotCompatibilitySchema,
  now: IsoDateSchema,
  limit: z.number().int().min(1).max(100),
}).strict();

export async function reconcileMissingGoldenSnapshotBuilds(
  db: PlatformDB,
  rawInput: z.input<typeof MissingBuildReconciliationInputSchema>,
): Promise<{ enqueued: number }> {
  const input = MissingBuildReconciliationInputSchema.parse(rawInput);
  const key = compatibilityKey(input.compatibility);
  await db.ready;
  const missing = await db.executor.selectFrom('host_bundle_releases')
    .select('version')
    .where('snapshot_eligible', '=', true)
    .where((eb) => eb.not(eb.exists(
      eb.selectFrom('golden_snapshots').select('snapshot_id')
        .whereRef('golden_snapshots.bundle_sha256', '=', 'host_bundle_releases.sha256')
        .where('golden_snapshots.compatibility_key', '=', key)
        .where('golden_snapshots.test_mode', '=', false),
    )))
    .orderBy('build_time', 'desc').limit(input.limit).execute();
  let enqueued = 0;
  for (const release of missing) {
    await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: release.version,
      compatibility: input.compatibility,
      snapshotId: randomUUID(),
      buildId: randomUUID(),
      now: input.now,
    });
    enqueued += 1;
  }
  return { enqueued };
}

export async function getGoldenSnapshotBuild(
  db: PlatformDB,
  rawBuildId: string,
): Promise<GoldenSnapshotBuildRecord | undefined> {
  const buildId = UuidSchema.parse(rawBuildId);
  await db.ready;
  const row = await db.executor.selectFrom('golden_snapshot_builds').selectAll()
    .where('build_id', '=', buildId).executeTakeFirst();
  return row ? mapBuild(row) : undefined;
}

export async function claimGoldenSnapshotBuild(
  db: PlatformDB,
  rawBuildId: string,
  rawNow: string,
  rawLeaseExpiresAt: string,
  rawMaxAttempts: number,
  rawMaxConcurrent: number = 2,
): Promise<GoldenSnapshotBuildRecord | undefined> {
  const buildId = UuidSchema.parse(rawBuildId);
  const now = IsoDateSchema.parse(rawNow);
  const leaseExpiresAt = IsoDateSchema.parse(rawLeaseExpiresAt);
  const maxAttempts = z.number().int().min(1).max(20).parse(rawMaxAttempts);
  const maxConcurrent = z.number().int().min(1).max(10).parse(rawMaxConcurrent);
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new Error('Golden snapshot build lease expiration must be after now');
  }
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('golden_snapshot_build_capacity'))`
      .execute(trx.executor);
    const active = await trx.executor.selectFrom('golden_snapshot_builds')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('status', '=', 'running')
      .where((eb) => eb.or([
        eb('lease_expires_at', '>', now),
        eb.and([
          eb('phase', 'in', ['builder_boot', 'validation_boot']),
          eb('callback_expires_at', '>', now),
        ]),
      ]))
      .executeTakeFirstOrThrow();
    const cleanupPending = await trx.executor.selectFrom('golden_snapshot_cleanup')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('resource_type', 'in', ['builder_server', 'validation_server'])
      .where('completed_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(active.count) + Number(cleanupPending.count) >= maxConcurrent) return undefined;
    const row = await trx.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', attempts: sql<number>`attempts + 1`, claimed_at: now,
      lease_expires_at: leaseExpiresAt, updated_at: now,
    }).where('build_id', '=', buildId).where('attempts', '<', maxAttempts)
      .where('phase', 'not in', ['builder_boot', 'validation_boot'])
      .where((eb) => eb.exists(
        eb.selectFrom('golden_snapshots').select('snapshot_id')
          .whereRef('golden_snapshots.snapshot_id', '=', 'golden_snapshot_builds.snapshot_id')
          .where('golden_snapshots.state', 'in', ['candidate', 'building', 'sanitizing', 'validating']),
      ))
      .where((eb) => eb.or([
        eb.and([eb('status', '=', 'queued'), eb('available_at', '<=', now)]),
        eb.and([
          eb('status', '=', 'running'),
          eb('lease_expires_at', '<=', now),
          eb.or([
            eb('phase', 'not in', ['builder_boot', 'validation_boot']),
            eb('callback_expires_at', 'is', null),
            eb('callback_expires_at', '<=', now),
          ]),
        ]),
      ])).returningAll().executeTakeFirst();
    if (row) return mapBuild(row);
    await terminalizeExhaustedGoldenSnapshotBuild(trx, buildId, now, maxAttempts);
    return undefined;
  });
}

async function terminalizeExhaustedGoldenSnapshotBuild(
  trx: PlatformDB,
  buildId: string,
  now: string,
  maxAttempts: number,
): Promise<boolean> {
  const exhausted = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
    .where('build_id', '=', buildId).where('status', '=', 'running')
    .where('attempts', '>=', maxAttempts).where('lease_expires_at', '<=', now)
    .where((eb) => eb.or([
      eb('phase', 'not in', ['builder_boot', 'validation_boot']),
      eb('callback_expires_at', 'is', null),
      eb('callback_expires_at', '<=', now),
    ]))
    .forUpdate().executeTakeFirst();
  if (!exhausted) return false;
  const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
    .where('snapshot_id', '=', exhausted.snapshot_id).forUpdate().executeTakeFirstOrThrow();
  await trx.executor.updateTable('golden_snapshot_builds').set({
    phase: 'failed', status: 'failed', last_error_code: 'retry_budget_exhausted',
    lease_expires_at: null, callback_phase: null, callback_token_hash: null,
    callback_expires_at: null, completed_at: now, updated_at: now,
  }).where('build_id', '=', buildId).where('status', '=', 'running')
    .where('attempts', '>=', maxAttempts).executeTakeFirstOrThrow();
  await trx.executor.updateTable('golden_snapshots').set({
    state: 'failed', failure_code: 'retry_budget_exhausted', updated_at: now,
    revision: sql<number>`revision + 1`,
  }).where('snapshot_id', '=', snapshot.snapshot_id)
    .where('state', 'in', ['candidate', 'building', 'sanitizing', 'validating']).execute();
  await appendGoldenSnapshotAuditEvent(trx, {
    snapshotId: snapshot.snapshot_id, buildId, eventType: 'build_failed', actorType: 'worker',
    fromState: snapshot.state, toState: 'failed', reason: 'retry_budget_exhausted', now,
  });
  const resources = [
    exhausted.provider_builder_id === null ? undefined : {
      type: 'builder_server' as const, id: exhausted.provider_builder_id,
    },
    exhausted.provider_validation_id === null ? undefined : {
      type: 'validation_server' as const, id: exhausted.provider_validation_id,
    },
    snapshot.provider_image_id === null ? undefined : {
      type: 'snapshot_image' as const, id: snapshot.provider_image_id,
    },
  ].filter((resource): resource is {
    type: 'builder_server' | 'validation_server' | 'snapshot_image'; id: number;
  } => resource !== undefined);
  for (const resource of resources) {
    await trx.executor.insertInto('golden_snapshot_cleanup').values({
      cleanup_id: randomUUID(), snapshot_id: snapshot.snapshot_id, build_id: buildId,
      resource_type: resource.type, provider_resource_id: resource.id,
      provenance_key: `build:${buildId}:${resource.type}`, reason: 'retry_budget_exhausted',
      status: 'queued', attempts: 0, next_attempt_at: now, lease_expires_at: null,
      last_error_code: null, created_at: now, completed_at: null,
    }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
      .where('completed_at', 'is', null).doNothing()).execute();
  }
  return true;
}

export async function claimGoldenSnapshotBuildBatch(
  db: PlatformDB,
  rawNow: string,
  rawLeaseExpiresAt: string,
  rawMaxAttempts: number,
  rawLimit: number,
  rawMaxConcurrent: number,
): Promise<GoldenSnapshotBuildRecord[]> {
  const now = IsoDateSchema.parse(rawNow);
  const leaseExpiresAt = IsoDateSchema.parse(rawLeaseExpiresAt);
  const maxAttempts = z.number().int().min(1).max(20).parse(rawMaxAttempts);
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  const maxConcurrent = z.number().int().min(1).max(10).parse(rawMaxConcurrent);
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new Error('Golden snapshot build lease expiration must be after now');
  }
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('golden_snapshot_build_capacity'))`
      .execute(trx.executor);
    const exhausted = await trx.executor.selectFrom('golden_snapshot_builds').select('build_id')
      .where('status', '=', 'running').where('attempts', '>=', maxAttempts)
      .where('lease_expires_at', '<=', now)
      .where((eb) => eb.or([
        eb('phase', 'not in', ['builder_boot', 'validation_boot']),
        eb('callback_expires_at', 'is', null),
        eb('callback_expires_at', '<=', now),
      ]))
      .orderBy('build_id').forUpdate().skipLocked()
      .limit(limit).execute();
    for (const row of exhausted) {
      await terminalizeExhaustedGoldenSnapshotBuild(trx, row.build_id, now, maxAttempts);
    }
    const active = await trx.executor.selectFrom('golden_snapshot_builds')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('status', '=', 'running')
      .where((eb) => eb.or([
        eb('lease_expires_at', '>', now),
        eb.and([
          eb('phase', 'in', ['builder_boot', 'validation_boot']),
          eb('callback_expires_at', '>', now),
        ]),
      ]))
      .executeTakeFirstOrThrow();
    const cleanupPending = await trx.executor.selectFrom('golden_snapshot_cleanup')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('resource_type', 'in', ['builder_server', 'validation_server'])
      .where('completed_at', 'is', null)
      .executeTakeFirstOrThrow();
    const capacity = Math.min(
      limit,
      Math.max(0, maxConcurrent - Number(active.count) - Number(cleanupPending.count)),
    );
    if (capacity === 0) return [];
    const candidates = await trx.executor.selectFrom('golden_snapshot_builds')
      .select('build_id')
      .where('attempts', '<', maxAttempts)
      .where('phase', 'not in', ['builder_boot', 'validation_boot'])
      .where((eb) => eb.exists(
        eb.selectFrom('golden_snapshots').select('snapshot_id')
          .whereRef('golden_snapshots.snapshot_id', '=', 'golden_snapshot_builds.snapshot_id')
          .where('golden_snapshots.state', 'in', ['candidate', 'building', 'sanitizing', 'validating']),
      ))
      .where((eb) => eb.or([
        eb.and([eb('status', '=', 'queued'), eb('available_at', '<=', now)]),
        eb.and([
          eb('status', '=', 'running'),
          eb('lease_expires_at', '<=', now),
          eb.or([
            eb('phase', 'not in', ['builder_boot', 'validation_boot']),
            eb('callback_expires_at', 'is', null),
            eb('callback_expires_at', '<=', now),
          ]),
        ]),
      ]))
      .orderBy('available_at')
      .orderBy('build_id')
      .forUpdate()
      .skipLocked()
      .limit(capacity)
      .execute();
    const claimed: GoldenSnapshotBuildRecord[] = [];
    for (const candidate of candidates) {
      const row = await trx.executor.updateTable('golden_snapshot_builds').set({
        status: 'running',
        attempts: sql<number>`attempts + 1`,
        claimed_at: now,
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      }).where('build_id', '=', candidate.build_id)
        .where('attempts', '<', maxAttempts)
        .where('phase', 'not in', ['builder_boot', 'validation_boot'])
        .where((eb) => eb.or([
          eb.and([eb('status', '=', 'queued'), eb('available_at', '<=', now)]),
          eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', now)]),
        ]))
        .returningAll()
        .executeTakeFirst();
      if (row) claimed.push(mapBuild(row));
    }
    return claimed;
  });
}

export async function listClaimableGoldenSnapshotBuildIds(
  db: PlatformDB,
  rawNow: string,
  rawLimit: number,
  rawMaxAttempts: number,
): Promise<string[]> {
  const now = IsoDateSchema.parse(rawNow);
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  const maxAttempts = z.number().int().min(1).max(10).parse(rawMaxAttempts);
  await db.ready;
  const rows = await db.executor.selectFrom('golden_snapshot_builds').select('build_id')
    .where((eb) => eb.or([
      eb.and([
        eb('status', '=', 'queued'), eb('attempts', '<', maxAttempts), eb('available_at', '<=', now),
      ]),
      eb.and([
        eb('status', '=', 'running'),
        eb('phase', 'not in', ['builder_boot', 'validation_boot']),
        eb('lease_expires_at', '<=', now),
      ]),
    ])).orderBy('available_at').limit(limit).execute();
  return rows.map((row) => row.build_id);
}

export async function listRunnableGoldenSnapshotBuildIds(
  db: PlatformDB,
  rawNow: string,
  rawLimit: number,
): Promise<string[]> {
  const now = IsoDateSchema.parse(rawNow);
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  return db.transaction(async (trx) => {
    const rows = await trx.executor.selectFrom('golden_snapshot_builds').select('build_id')
      .where('status', '=', 'running')
      .where('lease_expires_at', '>', now)
      .where('phase', 'in', [
        'requested', 'builder_create', 'snapshot_create', 'snapshot_wait', 'validation_create',
      ])
      .orderBy('updated_at').orderBy('build_id').forUpdate().skipLocked().limit(limit).execute();
    const ids = rows.map((row) => row.build_id);
    if (ids.length > 0) {
      await trx.executor.updateTable('golden_snapshot_builds').set({ updated_at: now })
        .where('build_id', 'in', ids).execute();
    }
    return ids;
  });
}

export async function listCallbackWaitGoldenSnapshotBuildIds(
  db: PlatformDB,
  rawLimit: number,
): Promise<string[]> {
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  const rows = await db.executor.selectFrom('golden_snapshot_builds').select('build_id')
    .where('status', '=', 'running')
    .where('phase', 'in', ['builder_boot', 'validation_boot'])
    .orderBy('callback_expires_at').orderBy('build_id').limit(limit).execute();
  return rows.map((row) => row.build_id);
}

export async function listUnresolvedGoldenSnapshotBuildIds(
  db: PlatformDB,
  rawLimit: number,
): Promise<string[]> {
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  const rows = await db.executor.selectFrom('golden_snapshot_builds').select('build_id')
    .where('status', '=', 'failed')
    .where('pending_operation', 'is not', null)
    .where('callback_expires_at', 'is not', null)
    .orderBy('updated_at')
    .limit(limit)
    .execute();
  return rows.map((row) => row.build_id);
}

export async function advanceGoldenSnapshot(
  db: PlatformDB,
  rawSnapshotId: string,
  rawBuildId: string,
  rawExpectedLeaseExpiresAt: string,
  rawFrom: GoldenSnapshotState,
  rawTo: GoldenSnapshotState,
  rawNow: string,
): Promise<boolean> {
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  const buildId = UuidSchema.parse(rawBuildId);
  const expectedLeaseExpiresAt = IsoDateSchema.parse(rawExpectedLeaseExpiresAt);
  const from = GoldenSnapshotStateSchema.parse(rawFrom);
  const to = GoldenSnapshotStateSchema.parse(rawTo);
  const now = IsoDateSchema.parse(rawNow);
  if (!canTransitionGoldenSnapshot(from, to)) throw new Error(`Invalid golden snapshot transition: ${from} -> ${to}`);
  const genericTransitions = new Set([
    'candidate:building', 'building:sanitizing', 'sanitizing:validating',
  ]);
  if (!genericTransitions.has(`${from}:${to}`)) {
    throw new Error(`Golden snapshot specialized lifecycle transition required: ${from} -> ${to}`);
  }
  await db.ready;
  return db.transaction(async (trx) => {
    const activeBuild = await trx.executor.selectFrom('golden_snapshot_builds')
      .select('build_id')
      .where('build_id', '=', buildId)
      .where('snapshot_id', '=', snapshotId)
      .where('status', '=', 'running')
      .where('lease_expires_at', '=', expectedLeaseExpiresAt)
      .where('lease_expires_at', '>', now)
      .forUpdate()
      .executeTakeFirst();
    if (!activeBuild) return false;
    const result = await trx.executor.updateTable('golden_snapshots').set({
      state: to,
      updated_at: now,
      revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshotId).where('state', '=', from)
      .returning('snapshot_id').executeTakeFirst();
    if (!result) return false;
    const phaseByState: Partial<Record<GoldenSnapshotState, string>> = {
      building: 'builder_create',
      sanitizing: 'sanitizing',
      validating: 'validation_create',
    };
    const phase = phaseByState[to];
    if (!phase) throw new Error(`Missing build phase for golden snapshot state: ${to}`);
    await trx.executor.updateTable('golden_snapshot_builds').set({ phase, updated_at: now })
      .where('build_id', '=', buildId).where('status', '=', 'running')
      .where('lease_expires_at', '=', expectedLeaseExpiresAt).executeTakeFirstOrThrow();
    await appendGoldenSnapshotAuditEvent(trx, {
      snapshotId, buildId, eventType: 'snapshot_transition', actorType: 'worker',
      fromState: from, toState: to, now,
    });
    return true;
  });
}

const ProviderImageInputSchema = z.object({
  buildId: UuidSchema,
  expectedLeaseExpiresAt: IsoDateSchema,
  providerSnapshotActionId: z.number().int().positive().nullable().optional(),
  providerImageId: z.number().int().positive(),
  providerImageStatus: z.enum(['creating', 'available']),
  imageDiskGb: z.number().int().min(1).max(2_048),
  imageArchitecture: z.enum(['x86', 'arm']),
  now: IsoDateSchema,
}).strict();

export async function recordGoldenSnapshotProviderImage(
  db: PlatformDB,
  rawSnapshotId: string,
  rawInput: z.input<typeof ProviderImageInputSchema>,
): Promise<boolean> {
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  const input = ProviderImageInputSchema.parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
      .where('build_id', '=', input.buildId).where('snapshot_id', '=', snapshotId)
      .forUpdate().executeTakeFirst();
    const current = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
    if (!current) return false;
    const queueLateImage = async (): Promise<void> => {
      await trx.executor.insertInto('golden_snapshot_cleanup').values({
        cleanup_id: randomUUID(), snapshot_id: snapshotId, build_id: build?.build_id ?? null,
        resource_type: 'snapshot_image', provider_resource_id: input.providerImageId,
        provenance_key: `snapshot:${snapshotId}`, reason: 'late_provider_image',
        status: 'queued', attempts: 0, next_attempt_at: input.now, lease_expires_at: null,
        last_error_code: null, created_at: input.now, completed_at: null,
      }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
        .where('completed_at', 'is', null).doNothing()).execute();
    };
    const isCurrentProviderImage = current.provider_image_id !== null
      && Number(current.provider_image_id) === input.providerImageId;
    if (isCurrentProviderImage && current.architecture !== input.imageArchitecture) {
      const quarantined = await trx.executor.updateTable('golden_snapshots').set({
        state: 'quarantined', failure_code: 'provider_image_metadata_conflict',
        quarantined_at: input.now, updated_at: input.now, revision: sql<number>`revision + 1`,
      }).where('snapshot_id', '=', snapshotId).where('revision', '=', current.revision)
        .returning('snapshot_id').executeTakeFirst();
      if (quarantined) {
        await appendGoldenSnapshotAuditEvent(trx, {
          snapshotId, buildId: build?.build_id, eventType: 'snapshot_quarantined', actorType: 'worker',
          fromState: current.state, toState: 'quarantined',
          reason: 'provider_image_metadata_conflict', now: input.now,
        });
      }
      return false;
    }
    if (current.state === 'ready' && isCurrentProviderImage) return true;
    if (!build || build.status !== 'running'
      || build.lease_expires_at !== input.expectedLeaseExpiresAt
      || build.lease_expires_at <= input.now) {
      await queueLateImage();
      return false;
    }
    if (!['sanitizing', 'validating'].includes(current.state)
      || current.architecture !== input.imageArchitecture) {
      await queueLateImage();
      return false;
    }
    if (current.provider_image_id !== null && Number(current.provider_image_id) !== input.providerImageId) {
      await trx.executor.updateTable('golden_snapshot_builds').set({
        phase: 'failed', status: 'failed', last_error_code: 'provider_image_identity_conflict',
        lease_expires_at: null, callback_phase: null, callback_token_hash: null,
        callback_expires_at: null, pending_operation: null,
        completed_at: input.now, updated_at: input.now,
      }).where('build_id', '=', build.build_id)
        .where('status', '=', 'running').executeTakeFirstOrThrow();
      await trx.executor.updateTable('golden_snapshots').set({
        state: 'quarantined', failure_code: 'provider_image_identity_conflict',
        quarantined_at: input.now, updated_at: input.now, revision: sql<number>`revision + 1`,
      }).where('snapshot_id', '=', snapshotId).where('revision', '=', current.revision).executeTakeFirstOrThrow();
      await appendGoldenSnapshotAuditEvent(trx, {
        snapshotId, buildId: build.build_id, eventType: 'snapshot_quarantined', actorType: 'worker',
        fromState: current.state, toState: 'quarantined', reason: 'provider_image_identity_conflict', now: input.now,
      });
      const resources = [
        build?.provider_builder_id === null || build?.provider_builder_id === undefined ? undefined : {
          type: 'builder_server' as const, id: build.provider_builder_id,
        },
        build?.provider_validation_id === null || build?.provider_validation_id === undefined ? undefined : {
          type: 'validation_server' as const, id: build.provider_validation_id,
        },
        { type: 'snapshot_image' as const, id: Number(current.provider_image_id) },
        { type: 'snapshot_image' as const, id: input.providerImageId },
      ].filter((resource): resource is {
        type: 'builder_server' | 'validation_server' | 'snapshot_image'; id: number;
      } => resource !== undefined);
      for (const resource of resources) {
        await trx.executor.insertInto('golden_snapshot_cleanup').values({
          cleanup_id: randomUUID(), snapshot_id: snapshotId, build_id: build?.build_id ?? null,
          resource_type: resource.type, provider_resource_id: resource.id,
          provenance_key: `snapshot:${snapshotId}:conflict:${resource.type}:${resource.id}`,
          reason: 'provider_image_identity_conflict', status: 'queued', attempts: 0,
          next_attempt_at: input.now, lease_expires_at: null, last_error_code: null,
          created_at: input.now, completed_at: null,
        }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
          .where('completed_at', 'is', null).doNothing()).execute();
      }
      return false;
    }
    if (current.provider_image_status === 'available' && input.providerImageStatus === 'creating') {
      return true;
    }
    const row = await trx.executor.updateTable('golden_snapshots').set({
      state: 'validating',
      provider_image_id: input.providerImageId, provider_image_status: input.providerImageStatus,
      image_disk_gb: input.imageDiskGb, image_architecture: input.imageArchitecture,
      updated_at: input.now, revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshotId).where('revision', '=', current.revision)
      .where('state', 'in', ['sanitizing', 'validating'])
      .returning('snapshot_id').executeTakeFirst();
    if (!row) return false;
    await trx.executor.updateTable('golden_snapshot_builds').set({
      provider_snapshot_action_id: input.providerSnapshotActionId ?? build.provider_snapshot_action_id,
      pending_operation: null,
      updated_at: input.now,
    }).where('build_id', '=', build.build_id)
      .where('status', '=', 'running')
      .where('lease_expires_at', '=', input.expectedLeaseExpiresAt)
      .executeTakeFirstOrThrow();
    if (current.state !== 'validating') {
      await appendGoldenSnapshotAuditEvent(trx, {
        snapshotId, buildId: build.build_id, eventType: 'snapshot_transition', actorType: 'worker',
        fromState: current.state, toState: 'validating', now: input.now,
      });
    }
    return true;
  });
}

export async function markGoldenSnapshotReady(
  db: PlatformDB,
  rawSnapshotId: string,
  rawBuildId: string,
  rawInput: { validationSummary: GoldenSnapshotValidationSummary; expectedLeaseExpiresAt: string; now: string },
): Promise<GoldenSnapshotRecord> {
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  const buildId = UuidSchema.parse(rawBuildId);
  const validationSummary = GoldenSnapshotValidationSummarySchema.parse(rawInput.validationSummary);
  const expectedLeaseExpiresAt = IsoDateSchema.parse(rawInput.expectedLeaseExpiresAt);
  const now = IsoDateSchema.parse(rawInput.now);
  await db.ready;
  return db.transaction(async (trx) => {
    const baseGeneration = await trx.executor.selectFrom('golden_snapshots')
      .select('base_generation').where('snapshot_id', '=', snapshotId).executeTakeFirstOrThrow();
    await sql`SELECT pg_advisory_xact_lock(hashtext(${baseGeneration.base_generation}))`.execute(trx.executor);
    const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
      .where('build_id', '=', buildId).where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
    if (!build || build.phase !== 'validation_boot' || build.status !== 'running'
      || build.lease_expires_at !== expectedLeaseExpiresAt || build.lease_expires_at <= now) {
      throw new Error('Golden snapshot readiness requires the current validation lease');
    }
    const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirstOrThrow();
    const revokedGeneration = await trx.executor.selectFrom('golden_snapshot_revoked_base_generations')
      .select('base_generation').where('base_generation', '=', snapshot.base_generation).executeTakeFirst();
    if (revokedGeneration) throw new Error('Base generation is revoked');
    if (snapshot.state !== 'validating' || snapshot.provider_image_status !== 'available'
      || snapshot.provider_image_id === null || snapshot.image_architecture !== snapshot.architecture) {
      throw new Error('Golden snapshot is not validated and available');
    }
    await trx.executor.updateTable('golden_snapshot_builds').set({
      phase: 'completed', status: 'completed', updated_at: now, completed_at: now,
      lease_expires_at: null, callback_token_hash: null, callback_expires_at: null,
    }).where('build_id', '=', buildId).where('status', '=', 'running').executeTakeFirstOrThrow();
    const snapshotRow = await trx.executor.updateTable('golden_snapshots').set({
      state: 'ready', validation_summary: validationSummary, ready_at: now, updated_at: now,
      failure_code: null, revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshotId).where('revision', '=', snapshot.revision)
      .returningAll().executeTakeFirst();
    if (!snapshotRow) throw new Error('Golden snapshot is not validated and available');
    await appendGoldenSnapshotAuditEvent(trx, {
      snapshotId, buildId, eventType: 'snapshot_ready', actorType: 'worker',
      fromState: snapshot.state, toState: 'ready', now,
    });
    return mapSnapshot(snapshotRow);
  });
}

const SelectInputSchema = z.object({
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

async function retireQuarantinedSnapshotAfterLeaseDrain(
  trx: PlatformDB,
  snapshot: {
    snapshot_id: string;
    state: string;
    provider_image_id: number | null;
    failure_code: string | null;
    revision: number;
  },
  now: string,
): Promise<void> {
  if (snapshot.state !== 'quarantined' || snapshot.provider_image_id === null) return;
  const remainingLease = await trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
    .where('snapshot_id', '=', snapshot.snapshot_id).where('released_at', 'is', null)
    .executeTakeFirst();
  if (remainingLease) return;
  await trx.executor.insertInto('golden_snapshot_cleanup').values({
    cleanup_id: randomUUID(), snapshot_id: snapshot.snapshot_id, build_id: null,
    resource_type: 'snapshot_image', provider_resource_id: snapshot.provider_image_id,
    provenance_key: `snapshot:${snapshot.snapshot_id}`,
    reason: snapshot.failure_code ?? 'revoked', status: 'queued', attempts: 0,
    next_attempt_at: now, lease_expires_at: null, last_error_code: null,
    created_at: now, completed_at: null,
  }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
    .where('completed_at', 'is', null).doNothing()).execute();
  await trx.executor.updateTable('golden_snapshots').set({
    state: 'retiring', retiring_at: now, updated_at: now,
    revision: sql<number>`revision + 1`,
  }).where('snapshot_id', '=', snapshot.snapshot_id)
    .where('revision', '=', snapshot.revision)
    .where('state', '=', 'quarantined')
    .executeTakeFirstOrThrow();
  await appendGoldenSnapshotAuditEvent(trx, {
    snapshotId: snapshot.snapshot_id, eventType: 'snapshot_retiring', actorType: 'worker',
    fromState: 'quarantined', toState: 'retiring', reason: snapshot.failure_code, now,
  });
}

export async function selectAndLeaseGoldenSnapshot(
  db: PlatformDB,
  rawInput: z.input<typeof SelectInputSchema>,
): Promise<{ snapshot: GoldenSnapshotRecord; lease: GoldenSnapshotLeaseRecord } | undefined> {
  const parsedInput = SelectInputSchema.parse(rawInput);
  const input = {
    ...parsedInput,
    now: new Date(parsedInput.now).toISOString(),
    expiresAt: new Date(parsedInput.expiresAt).toISOString(),
  };
  const key = compatibilityKey(input.compatibility);
  const leaseDurationMs = Date.parse(input.expiresAt) - Date.parse(input.now);
  if (leaseDurationMs <= 0) {
    throw new Error('Golden snapshot lease expiration must be after now');
  }
  if (leaseDurationMs > input.maxLeaseMs) {
    throw new Error('Golden snapshot lease exceeds maximum TTL');
  }
  const freshnessCutoff = new Date(
    new Date(input.now).getTime() - input.freshnessMaxAgeMs,
  ).toISOString();
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.compatibility.baseGeneration}))`.execute(trx.executor);
    const existingLease = await trx.executor.selectFrom('golden_snapshot_leases')
      .selectAll()
      .where('golden_snapshot_leases.machine_id', '=', input.machineId)
      .where('golden_snapshot_leases.released_at', 'is', null).forUpdate().executeTakeFirst();
    if (existingLease) {
      const sameTarget = existingLease.purpose === input.purpose
        && existingLease.target_bundle_version === input.targetBundleVersion;
      const expired = new Date(existingLease.expires_at).getTime() <= new Date(input.now).getTime();
      const leasedSnapshotRow = await trx.executor.selectFrom('golden_snapshots').selectAll()
        .where('snapshot_id', '=', existingLease.snapshot_id).forUpdate().executeTakeFirst();
      const snapshotRow = sameTarget && leasedSnapshotRow?.state === 'ready'
        ? leasedSnapshotRow
        : undefined;
      const existingSnapshot = snapshotRow ? mapSnapshot(snapshotRow) : undefined;
      const revokedGeneration = existingSnapshot
        ? await trx.executor.selectFrom('golden_snapshot_revoked_base_generations')
          .select('base_generation').where('base_generation', '=', existingSnapshot.compatibility.baseGeneration)
          .executeTakeFirst()
        : undefined;
      const reusable = existingSnapshot !== undefined
        && revokedGeneration === undefined
        && existingSnapshot.providerImageId !== null
        && existingSnapshot.providerImageStatus === 'available'
        && existingSnapshot.readyAt !== null
        && existingSnapshot.readyAt > freshnessCutoff
        && !existingSnapshot.testMode
        && existingSnapshot.compatibilityKey === key
        && existingSnapshot.compatibility.activationAbi === input.compatibility.activationAbi
        && existingSnapshot.compatibility.minimumDiskGb <= input.serverDiskGb
        && (existingSnapshot.imageDiskGb === null || existingSnapshot.imageDiskGb <= input.serverDiskGb);
      if (!expired) {
        if (!sameTarget || !reusable) return undefined;
        return { snapshot: existingSnapshot, lease: mapLease(existingLease) };
      }
      if (reusable) {
        const renewed = await trx.executor.updateTable('golden_snapshot_leases')
          .set({ expires_at: input.expiresAt })
          .where('lease_id', '=', existingLease.lease_id).where('released_at', 'is', null)
          .returningAll().executeTakeFirst();
        if (!renewed) return undefined;
        return { snapshot: existingSnapshot, lease: mapLease(renewed) };
      }
      const provisioningJob = await trx.executor.selectFrom('provisioning_jobs').select('status')
        .where('machine_id', '=', input.machineId).executeTakeFirst();
      const recoveryMachine = existingLease.purpose === 'recover'
        ? await trx.executor.selectFrom('user_machines').select('status')
          .where('machine_id', '=', input.machineId).where('deleted_at', 'is', null).executeTakeFirst()
        : undefined;
      if (provisioningJob?.status === 'queued' || provisioningJob?.status === 'running'
        || recoveryMachine?.status === 'recovering') return undefined;
      const released = await trx.executor.updateTable('golden_snapshot_leases').set({ released_at: input.now })
        .where('lease_id', '=', existingLease.lease_id).where('released_at', 'is', null)
        .returning('lease_id').executeTakeFirst();
      if (!released) return undefined;
      if (leasedSnapshotRow) {
        await retireQuarantinedSnapshotAfterLeaseDrain(trx, leasedSnapshotRow, input.now);
      }
    }
    const target = await trx.executor.selectFrom('host_bundle_releases').select(['sha256', 'build_time'])
      .where('version', '=', input.targetBundleVersion).executeTakeFirstOrThrow();
    const targetSha256 = Sha256Schema.parse(target.sha256.toLowerCase());
    const candidates = await trx.executor.selectFrom('golden_snapshots')
      .innerJoin('host_bundle_releases', 'host_bundle_releases.version', 'golden_snapshots.bundle_version')
      .selectAll('golden_snapshots').select('host_bundle_releases.build_time as source_release_build_time')
      .where('golden_snapshots.state', '=', 'ready').where('golden_snapshots.compatibility_key', '=', key)
      .where('golden_snapshots.ready_at', '>', freshnessCutoff)
      .where('golden_snapshots.test_mode', '=', false)
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom('golden_snapshot_revoked_base_generations').select('base_generation')
          .whereRef('golden_snapshot_revoked_base_generations.base_generation', '=', 'golden_snapshots.base_generation'),
      )))
      .where('golden_snapshots.minimum_disk_gb', '<=', input.serverDiskGb)
      .where((eb) => eb.or([
        eb('golden_snapshots.bundle_sha256', '=', targetSha256),
        sql<boolean>`${sql.ref('host_bundle_releases.build_time')}::timestamptz < ${target.build_time}::timestamptz`,
      ]))
      .where((eb) => eb.or([
        eb('golden_snapshots.image_disk_gb', 'is', null),
        eb('golden_snapshots.image_disk_gb', '<=', input.serverDiskGb),
      ]))
      .orderBy(sql<number>`CASE WHEN ${sql.ref('golden_snapshots.bundle_sha256')} = ${targetSha256} THEN 0 ELSE 1 END`)
      .orderBy(sql`${sql.ref('host_bundle_releases.build_time')}::timestamptz`, 'desc')
      .orderBy('golden_snapshots.ready_at', 'desc').limit(100).execute();
    const chosen = chooseGoldenSnapshot({
      targetBundleSha256: targetSha256,
      targetReleaseBuildTime: target.build_time,
      compatibilityKey: key,
      serverDiskGb: input.serverDiskGb,
      activationAbi: input.compatibility.activationAbi,
    }, candidates.map((row) => ({
      snapshotId: row.snapshot_id,
      bundleVersion: row.bundle_version,
      bundleSha256: row.bundle_sha256,
      compatibilityKey: row.compatibility_key,
      sourceReleaseBuildTime: row.source_release_build_time,
      state: GoldenSnapshotStateSchema.parse(row.state),
      minimumDiskGb: row.minimum_disk_gb,
      imageDiskGb: row.image_disk_gb,
      activationAbi: row.activation_abi,
      readyAt: row.ready_at ?? '',
    })));
    if (!chosen) return undefined;
    const locked = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', chosen.snapshotId).where('state', '=', 'ready').forUpdate().executeTakeFirst();
    if (!locked) return undefined;
    const snapshot = mapSnapshot(locked);
    if (snapshot.providerImageId === null || snapshot.readyAt === null || snapshot.readyAt <= freshnessCutoff) return undefined;
    const leaseRow = await trx.executor.insertInto('golden_snapshot_leases').values({
      lease_id: input.leaseId,
      snapshot_id: snapshot.snapshotId,
      machine_id: input.machineId,
      purpose: input.purpose,
      target_bundle_version: input.targetBundleVersion,
      created_at: input.now,
      expires_at: input.expiresAt,
      released_at: null,
    }).onConflict((oc) => oc.column('machine_id').where('released_at', 'is', null).doNothing())
      .returningAll().executeTakeFirst();
    if (!leaseRow) return undefined;
    if (input.provisioningJobId) {
      const job = await trx.executor.updateTable('provisioning_jobs').set({
        target_bundle_version: input.targetBundleVersion,
        target_bundle_sha256: target.sha256,
        image_source: 'snapshot',
        snapshot_id: snapshot.snapshotId,
        snapshot_lease_id: input.leaseId,
        activation_step: 'creating',
        fallback_reason: null,
        updated_at: input.now,
      }).where('job_id', '=', input.provisioningJobId).where('machine_id', '=', input.machineId)
        .where('status', '=', 'running').returning('job_id').executeTakeFirst();
      if (!job) throw new Error('Provisioning job lost before snapshot lease commit');
    }
    return { snapshot, lease: mapLease(leaseRow) };
  });
}

export async function createGoldenSnapshotCreateIntent(
  db: PlatformDB,
  rawInput: {
    intentId: string;
    snapshotId: string;
    leaseId: string;
    machineId: string;
    purpose: 'provision' | 'recover';
    rolloutGeneration: number;
    now: string;
  },
): Promise<GoldenSnapshotCreateIntentRecord | undefined> {
  const input = z.object({
    intentId: UuidSchema, snapshotId: UuidSchema, leaseId: UuidSchema, machineId: UuidSchema,
    purpose: z.enum(['provision', 'recover']), rolloutGeneration: z.number().int().nonnegative(),
    now: IsoDateSchema,
  }).parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    const identity = await trx.executor.selectFrom('golden_snapshots')
      .select(['snapshot_id', 'base_generation']).where('snapshot_id', '=', input.snapshotId)
      .executeTakeFirst();
    if (!identity) return undefined;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.base_generation}))`.execute(trx.executor);
    const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', input.snapshotId).forUpdate().executeTakeFirst();
    if (!snapshot || snapshot.state !== 'ready') return undefined;
    const revoked = await trx.executor.selectFrom('golden_snapshot_revoked_base_generations')
      .select('base_generation').where('base_generation', '=', snapshot.base_generation).executeTakeFirst();
    if (revoked) return undefined;
    const lease = await trx.executor.selectFrom('golden_snapshot_leases').selectAll()
      .where('lease_id', '=', input.leaseId).forUpdate().executeTakeFirst();
    if (!lease || lease.released_at !== null || lease.snapshot_id !== input.snapshotId
      || lease.machine_id !== input.machineId || lease.purpose !== input.purpose) return undefined;
    await trx.executor.insertInto('golden_snapshot_create_intents').values({
      intent_id: input.intentId, snapshot_id: input.snapshotId, lease_id: input.leaseId,
      machine_id: input.machineId, purpose: input.purpose,
      rollout_generation: input.rolloutGeneration, state: 'pending',
      provider_create_action_id: null, created_at: input.now, updated_at: input.now, completed_at: null,
    }).onConflict((oc) => oc.column('lease_id').doNothing()).execute();
    const row = await trx.executor.selectFrom('golden_snapshot_create_intents').selectAll()
      .where('lease_id', '=', input.leaseId).executeTakeFirstOrThrow();
    if (row.snapshot_id !== input.snapshotId || row.machine_id !== input.machineId
      || row.purpose !== input.purpose || Number(row.rollout_generation) !== input.rolloutGeneration) {
      throw new Error('Golden snapshot create intent provenance conflict');
    }
    return mapCreateIntent(row);
  });
}

export async function getGoldenSnapshotCreateIntent(
  db: PlatformDB,
  rawLeaseId: string,
): Promise<GoldenSnapshotCreateIntentRecord | undefined> {
  const leaseId = UuidSchema.parse(rawLeaseId);
  await db.ready;
  const row = await db.executor.selectFrom('golden_snapshot_create_intents').selectAll()
    .where('lease_id', '=', leaseId).executeTakeFirst();
  return row ? mapCreateIntent(row) : undefined;
}

export async function markGoldenSnapshotCreateIntentAccepted(
  db: PlatformDB,
  rawLeaseId: string,
  rawProviderActionId: number | null,
  rawNow: string,
): Promise<GoldenSnapshotCreateIntentRecord | undefined> {
  const leaseId = UuidSchema.parse(rawLeaseId);
  const providerActionId = rawProviderActionId === null
    ? null : z.number().int().positive().parse(rawProviderActionId);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction(async (trx) => {
    const current = await trx.executor.selectFrom('golden_snapshot_create_intents').selectAll()
      .where('lease_id', '=', leaseId).forUpdate().executeTakeFirst();
    if (!current || current.state === 'denied') return current ? mapCreateIntent(current) : undefined;
    if (!['pending', 'accepted'].includes(current.state)) return mapCreateIntent(current);
    const row = await trx.executor.updateTable('golden_snapshot_create_intents').set({
      state: 'accepted', provider_create_action_id: providerActionId ?? current.provider_create_action_id,
      updated_at: now,
    }).where('intent_id', '=', current.intent_id).returningAll().executeTakeFirstOrThrow();
    return mapCreateIntent(row);
  });
}

export async function markGoldenSnapshotCreateIntentCompleted(
  db: PlatformDB,
  rawLeaseId: string,
  rawState: 'activated' | 'cleaned',
  rawNow: string,
): Promise<boolean> {
  const leaseId = UuidSchema.parse(rawLeaseId);
  const state = z.enum(['activated', 'cleaned']).parse(rawState);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  const updated = await db.executor.updateTable('golden_snapshot_create_intents').set({
    state, updated_at: now, completed_at: now,
  }).where('lease_id', '=', leaseId).where('state', 'in', ['pending', 'accepted'])
    .returning('intent_id').executeTakeFirst();
  return updated !== undefined;
}

export async function releaseGoldenSnapshotLease(db: PlatformDB, rawLeaseId: string, rawNow: string): Promise<boolean> {
  const leaseId = UuidSchema.parse(rawLeaseId);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction(async (trx) => {
    const lease = await trx.executor.selectFrom('golden_snapshot_leases')
      .select(['snapshot_id', 'released_at'])
      .where('lease_id', '=', leaseId)
      .forUpdate().executeTakeFirst();
    if (!lease || lease.released_at !== null) return false;
    const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', lease.snapshot_id)
      .forUpdate()
      .executeTakeFirst();
    if (!snapshot) return false;
    const released = await trx.executor.updateTable('golden_snapshot_leases').set({ released_at: now })
      .where('lease_id', '=', leaseId).where('released_at', 'is', null)
      .returning('lease_id').executeTakeFirst();
    if (!released) return false;
    await retireQuarantinedSnapshotAfterLeaseDrain(trx, snapshot, now);
    return true;
  });
}

async function releaseExpiredGoldenSnapshotLease(
  db: PlatformDB,
  rawLeaseId: string,
  rawNow: string,
): Promise<boolean> {
  const leaseId = UuidSchema.parse(rawLeaseId);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction(async (trx) => {
    const lease = await trx.executor.selectFrom('golden_snapshot_leases')
      .selectAll().where('lease_id', '=', leaseId).forUpdate().executeTakeFirst();
    if (!lease || lease.released_at !== null || lease.expires_at > now) return false;

    if (lease.purpose === 'provision') {
      const job = await trx.executor.selectFrom('provisioning_jobs').select('status')
        .where('machine_id', '=', lease.machine_id).forUpdate().executeTakeFirst();
      if (job && !['completed', 'failed'].includes(job.status)) return false;
    } else {
      const machine = await trx.executor.selectFrom('user_machines').select('status')
        .where('machine_id', '=', lease.machine_id).forUpdate().executeTakeFirst();
      if (machine && !['running', 'failed', 'deleted'].includes(machine.status)) return false;
    }

    const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', lease.snapshot_id).forUpdate().executeTakeFirst();
    if (!snapshot) return false;
    const released = await trx.executor.updateTable('golden_snapshot_leases').set({ released_at: now })
      .where('lease_id', '=', leaseId).where('released_at', 'is', null)
      .returning('lease_id').executeTakeFirst();
    if (!released) return false;
    await retireQuarantinedSnapshotAfterLeaseDrain(trx, snapshot, now);
    return true;
  });
}

export async function reconcileExpiredGoldenSnapshotLeases(
  db: PlatformDB,
  rawNow: string,
  rawLimit: number,
): Promise<number> {
  const now = IsoDateSchema.parse(rawNow);
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  const provisionLeases = await db.executor.selectFrom('golden_snapshot_leases')
    .leftJoin('provisioning_jobs', 'provisioning_jobs.machine_id', 'golden_snapshot_leases.machine_id')
    .select('golden_snapshot_leases.lease_id')
    .where('golden_snapshot_leases.released_at', 'is', null)
    .where('golden_snapshot_leases.expires_at', '<=', now)
    .where('golden_snapshot_leases.purpose', '=', 'provision')
    .where((eb) => eb.or([
      eb('provisioning_jobs.job_id', 'is', null),
      eb('provisioning_jobs.status', 'in', ['completed', 'failed']),
    ]))
    .orderBy('golden_snapshot_leases.expires_at').orderBy('golden_snapshot_leases.lease_id')
    .limit(limit).execute();
  const remaining = limit - provisionLeases.length;
  const recoveryLeases = remaining === 0 ? [] : await db.executor
    .selectFrom('golden_snapshot_leases')
    .leftJoin('user_machines', 'user_machines.machine_id', 'golden_snapshot_leases.machine_id')
    .select('golden_snapshot_leases.lease_id')
    .where('golden_snapshot_leases.released_at', 'is', null)
    .where('golden_snapshot_leases.expires_at', '<=', now)
    .where('golden_snapshot_leases.purpose', '=', 'recover')
    .where((eb) => eb.or([
      eb('user_machines.machine_id', 'is', null),
      eb('user_machines.status', 'in', ['running', 'failed', 'deleted']),
      eb.and([
        eb('user_machines.status', '=', 'recovering'),
        eb('user_machines.hetzner_server_id', 'is not', null),
        eb('user_machines.recovery_create_action_id', 'is', null),
        eb('user_machines.recovery_encrypted_payload', 'is', null),
      ]),
    ]))
    .orderBy('golden_snapshot_leases.expires_at').orderBy('golden_snapshot_leases.lease_id')
    .limit(remaining).execute();
  let released = 0;
  for (const lease of [...provisionLeases, ...recoveryLeases]) {
    if (await releaseExpiredGoldenSnapshotLease(db, lease.lease_id, now)) released += 1;
  }
  return released;
}

export async function getGoldenSnapshotRecoveryRegistrationTarget(
  db: PlatformDB,
  rawMachineId: string,
): Promise<{
  leaseId: string;
  snapshotId: string;
  baseGeneration: string;
  targetBundleVersion: string;
  targetBundleSha256: string;
} | undefined> {
  const machineId = UuidSchema.parse(rawMachineId);
  await db.ready;
  const row = await db.executor.selectFrom('golden_snapshot_leases')
    .innerJoin('golden_snapshots', 'golden_snapshots.snapshot_id', 'golden_snapshot_leases.snapshot_id')
    .innerJoin('host_bundle_releases', 'host_bundle_releases.version', 'golden_snapshot_leases.target_bundle_version')
    .select([
      'golden_snapshot_leases.lease_id',
      'golden_snapshot_leases.snapshot_id',
      'golden_snapshot_leases.target_bundle_version',
      'golden_snapshots.base_generation',
      'host_bundle_releases.sha256 as target_bundle_sha256',
    ])
    .where('golden_snapshot_leases.machine_id', '=', machineId)
    .where('golden_snapshot_leases.purpose', '=', 'recover')
    .where('golden_snapshot_leases.released_at', 'is', null)
    .orderBy('golden_snapshot_leases.created_at', 'desc')
    .limit(1).executeTakeFirst();
  if (!row) return undefined;
  return {
    leaseId: UuidSchema.parse(row.lease_id),
    snapshotId: UuidSchema.parse(row.snapshot_id),
    baseGeneration: z.string().min(1).max(64).parse(row.base_generation),
    targetBundleVersion: GoldenSnapshotBundleVersionSchema.parse(row.target_bundle_version),
    targetBundleSha256: Sha256Schema.parse(row.target_bundle_sha256),
  };
}

export async function revokeGoldenSnapshot(
  db: PlatformDB, rawSnapshotId: string, rawFailureCode: string, rawNow: string,
): Promise<boolean> {
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  const failureCode = BoundedCodeSchema.parse(rawFailureCode);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction(async (trx) => {
    const snapshotIdentity = await trx.executor.selectFrom('golden_snapshots')
      .select(['snapshot_id', 'base_generation']).where('snapshot_id', '=', snapshotId)
      .executeTakeFirst();
    if (!snapshotIdentity) return false;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${snapshotIdentity.base_generation}))`
      .execute(trx.executor);
    const buildIdentity = await trx.executor.selectFrom('golden_snapshot_builds').select('build_id')
      .where('snapshot_id', '=', snapshotId).executeTakeFirst();
    const build = buildIdentity
      ? await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
        .where('build_id', '=', buildIdentity.build_id).forUpdate().executeTakeFirst()
      : undefined;
    const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
    if (!snapshot || !['candidate', 'building', 'sanitizing', 'validating', 'ready', 'failed'].includes(snapshot.state)) {
      return false;
    }
    const activeLease = await trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
      .where('snapshot_id', '=', snapshotId).where('released_at', 'is', null)
      .executeTakeFirst();
    await trx.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', failure_code: failureCode, quarantined_at: now, updated_at: now,
      revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshotId).where('revision', '=', snapshot.revision).executeTakeFirstOrThrow();
    await trx.executor.updateTable('golden_snapshot_create_intents').set({
      state: 'denied', updated_at: now,
    }).where('snapshot_id', '=', snapshotId).where('state', 'in', ['pending', 'accepted'])
      .where('completed_at', 'is', null).execute();
    await appendGoldenSnapshotAuditEvent(trx, {
      snapshotId, buildId: build?.build_id, eventType: 'snapshot_revoked', actorType: 'operator',
      fromState: snapshot.state, toState: 'quarantined', reason: failureCode, now,
    });
    if (build && (build.status === 'queued' || build.status === 'running')) {
      await trx.executor.updateTable('golden_snapshot_builds').set({
        phase: 'failed', status: 'failed', last_error_code: failureCode,
        lease_expires_at: null, callback_phase: null, callback_token_hash: null,
        callback_expires_at: build.pending_operation === null ? null : build.callback_expires_at,
        completed_at: now, updated_at: now,
      }).where('build_id', '=', build.build_id).where('status', 'in', ['queued', 'running']).execute();
    }
    const resources = [
      build?.provider_builder_id === null || build?.provider_builder_id === undefined ? undefined : {
        type: 'builder_server' as const, id: build.provider_builder_id,
      },
      build?.provider_validation_id === null || build?.provider_validation_id === undefined ? undefined : {
        type: 'validation_server' as const, id: build.provider_validation_id,
      },
      snapshot.provider_image_id === null || activeLease ? undefined : {
        type: 'snapshot_image' as const, id: snapshot.provider_image_id,
      },
    ].filter((resource): resource is {
      type: 'builder_server' | 'validation_server' | 'snapshot_image'; id: number;
    } => resource !== undefined);
    for (const resource of resources) {
      await trx.executor.insertInto('golden_snapshot_cleanup').values({
        cleanup_id: randomUUID(), snapshot_id: snapshotId, build_id: build?.build_id ?? null,
        resource_type: resource.type, provider_resource_id: resource.id,
        provenance_key: `revoke:${snapshotId}:${resource.type}`, reason: failureCode,
        status: 'queued', attempts: 0, next_attempt_at: now, lease_expires_at: null,
        last_error_code: null, created_at: now, completed_at: null,
      }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
        .where('completed_at', 'is', null).doNothing()).execute();
    }
    return true;
  });
}

export async function revokeGoldenSnapshotBaseGeneration(
  db: PlatformDB,
  rawBaseGeneration: string,
  rawFailureCode: string,
  rawNow: string,
): Promise<boolean> {
  const baseGeneration = GoldenSnapshotBaseGenerationSchema.parse(rawBaseGeneration);
  const failureCode = BoundedCodeSchema.parse(rawFailureCode);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${baseGeneration}))`.execute(trx.executor);
    const inserted = await trx.executor.insertInto('golden_snapshot_revoked_base_generations').values({
      base_generation: baseGeneration,
      reason: failureCode,
      revoked_at: now,
      updated_at: now,
    }).onConflict((oc) => oc.column('base_generation').doNothing()).returning('base_generation').executeTakeFirst();
    await trx.executor.updateTable('golden_snapshot_create_intents').set({
      state: 'denied', updated_at: now,
    }).where('snapshot_id', 'in', trx.executor.selectFrom('golden_snapshots')
      .select('snapshot_id').where('base_generation', '=', baseGeneration))
      .where('state', 'in', ['pending', 'accepted']).where('completed_at', 'is', null).execute();
    if (inserted) {
      await appendGoldenSnapshotAuditEvent(trx, {
        eventType: 'base_generation_revoked', actorType: 'operator', reason: failureCode, now,
      });
    }
    return inserted !== undefined;
  });
}

export async function reconcileRevokedGoldenSnapshotBaseGeneration(
  db: PlatformDB,
  rawBaseGeneration: string,
  rawNow: string,
  rawLimit = 100,
): Promise<{ processed: number; hasMore: boolean }> {
  const baseGeneration = GoldenSnapshotBaseGenerationSchema.parse(rawBaseGeneration);
  const now = IsoDateSchema.parse(rawNow);
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  return db.transaction(async (trx) => {
    const marker = await trx.executor.selectFrom('golden_snapshot_revoked_base_generations').selectAll()
      .where('base_generation', '=', baseGeneration).executeTakeFirst();
    if (!marker) return { processed: 0, hasMore: false };
    const candidates = await trx.executor.selectFrom('golden_snapshots').select('snapshot_id')
      .where('base_generation', '=', baseGeneration)
      .where('state', 'in', ['candidate', 'building', 'sanitizing', 'validating', 'ready', 'failed'])
      .orderBy('snapshot_id').limit(limit + 1).execute();
    const hasMore = candidates.length > limit;
    const snapshotIds = candidates.slice(0, limit).map((snapshot) => snapshot.snapshot_id);
    if (snapshotIds.length === 0) return { processed: 0, hasMore: false };
    const builds = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
      .where('snapshot_id', 'in', snapshotIds).orderBy('build_id').forUpdate().execute();
    const snapshots = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', 'in', snapshotIds)
      .where('state', 'in', ['candidate', 'building', 'sanitizing', 'validating', 'ready', 'failed'])
      .orderBy('snapshot_id').forUpdate().execute();
    if (snapshots.length === 0) return { processed: 0, hasMore };
    const leasedSnapshots = new Set((await trx.executor.selectFrom('golden_snapshot_leases')
      .select('snapshot_id').where('snapshot_id', 'in', snapshotIds)
      .where('released_at', 'is', null).execute()).map((lease) => lease.snapshot_id));
    await trx.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', failure_code: marker.reason, quarantined_at: now, updated_at: now,
      revision: sql<number>`revision + 1`,
    }).where('snapshot_id', 'in', snapshotIds)
      .where('state', 'in', ['candidate', 'building', 'sanitizing', 'validating', 'ready', 'failed']).execute();
    await trx.executor.updateTable('golden_snapshot_builds').set({
      phase: 'failed', status: 'failed', last_error_code: marker.reason,
      lease_expires_at: null, callback_phase: null, callback_token_hash: null,
      callback_expires_at: sql<string | null>`CASE
        WHEN pending_operation IS NULL THEN NULL
        ELSE callback_expires_at
      END`,
      completed_at: now, updated_at: now,
    }).where('snapshot_id', 'in', snapshotIds).where('status', 'in', ['queued', 'running']).execute();
    const buildBySnapshot = new Map(builds.map((build) => [build.snapshot_id, build]));
    for (const snapshot of snapshots) {
      const build = buildBySnapshot.get(snapshot.snapshot_id);
      await appendGoldenSnapshotAuditEvent(trx, {
        snapshotId: snapshot.snapshot_id, buildId: build?.build_id,
        eventType: 'snapshot_revoked', actorType: 'worker', fromState: snapshot.state,
        toState: 'quarantined', reason: marker.reason, now,
      });
      const resources = [
        build?.provider_builder_id === null || build?.provider_builder_id === undefined ? undefined : {
          type: 'builder_server' as const, id: build.provider_builder_id,
        },
        build?.provider_validation_id === null || build?.provider_validation_id === undefined ? undefined : {
          type: 'validation_server' as const, id: build.provider_validation_id,
        },
        snapshot.provider_image_id === null || leasedSnapshots.has(snapshot.snapshot_id) ? undefined : {
          type: 'snapshot_image' as const, id: snapshot.provider_image_id,
        },
      ].filter((resource): resource is {
        type: 'builder_server' | 'validation_server' | 'snapshot_image'; id: number;
      } => resource !== undefined);
      for (const resource of resources) {
        await trx.executor.insertInto('golden_snapshot_cleanup').values({
          cleanup_id: randomUUID(), snapshot_id: snapshot.snapshot_id, build_id: build?.build_id ?? null,
          resource_type: resource.type, provider_resource_id: resource.id,
          provenance_key: `revoke:${snapshot.snapshot_id}:${resource.type}`, reason: marker.reason,
          status: 'queued', attempts: 0, next_attempt_at: now, lease_expires_at: null,
          last_error_code: null, created_at: now, completed_at: null,
        }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
          .where('completed_at', 'is', null).doNothing()).execute();
      }
    }
    return { processed: snapshots.length, hasMore };
  });
}

export async function retireGoldenSnapshot(
  db: PlatformDB,
  rawSnapshotId: string,
  rawReason: string,
  rawNow: string,
  rawPolicy: z.input<typeof RetirementPolicySchema> = {},
): Promise<boolean> {
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  const reason = BoundedCodeSchema.parse(rawReason);
  const now = IsoDateSchema.parse(rawNow);
  const policy = RetirementPolicySchema.parse(rawPolicy);
  await db.ready;
  return db.transaction(async (trx) => {
    const retirementTarget = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', snapshotId).executeTakeFirst();
    if (!retirementTarget || !['ready', 'failed', 'quarantined'].includes(retirementTarget.state)) return false;
    const compatibilityRows = retirementTarget.state === 'ready'
      ? await trx.executor.selectFrom('golden_snapshots').selectAll()
        .where('compatibility_key', '=', retirementTarget.compatibility_key)
        .where('test_mode', '=', retirementTarget.test_mode)
        .where('state', '=', 'ready')
        .orderBy('snapshot_id').forUpdate().execute()
      : [await trx.executor.selectFrom('golden_snapshots').selectAll()
        .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst()];
    const snapshotRow = compatibilityRows.find((row) => row?.snapshot_id === snapshotId);
    if (!snapshotRow || !['ready', 'failed', 'quarantined'].includes(snapshotRow.state)) return false;
    const freshnessExpired = snapshotRow.state === 'ready'
      && policy.freshnessMaxAgeMs !== undefined
      && snapshotRow.ready_at !== null
      && new Date(snapshotRow.ready_at).getTime() <= new Date(now).getTime() - policy.freshnessMaxAgeMs;
    const release = await trx.executor.selectFrom('host_bundle_releases').select('version')
      .where('version', '=', snapshotRow.bundle_version).forUpdate().executeTakeFirst();
    if (!release) return false;
    const activeLease = await trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
      .where('snapshot_id', '=', snapshotId).where('released_at', 'is', null)
      .executeTakeFirst();
    if (activeLease) return false;
    const currentChannel = await trx.executor.selectFrom('host_bundle_channels').select('channel')
      .where('version', '=', snapshotRow.bundle_version).executeTakeFirst();
    if (snapshotRow.state === 'ready' && currentChannel && !freshnessExpired) return false;
    if (snapshotRow.state === 'ready' && policy.rollbackVersionsPerChannel > 0 && !freshnessExpired) {
      const rollbackReference = await sql<{ channel: string }>`
        SELECT channel
        FROM (
          SELECT channel, version,
            ROW_NUMBER() OVER (PARTITION BY channel ORDER BY promoted_at DESC, version DESC) AS rollback_rank
          FROM host_bundle_release_channels
        ) AS ranked_release_channels
        WHERE version = ${snapshotRow.bundle_version}
          AND rollback_rank <= ${policy.rollbackVersionsPerChannel}
        LIMIT 1
      `.execute(trx.executor);
      if (rollbackReference.rows.length > 0) return false;
    }
    if (snapshotRow.state === 'ready' && !freshnessExpired) {
      const otherReady = compatibilityRows.find((row) => row?.snapshot_id !== snapshotId);
      if (!otherReady) return false;
    }
    if (snapshotRow.provider_image_id !== null) {
      const build = await trx.executor.selectFrom('golden_snapshot_builds').select('build_id')
        .where('snapshot_id', '=', snapshotId).executeTakeFirst();
      await trx.executor.insertInto('golden_snapshot_cleanup').values({
        cleanup_id: randomUUID(), snapshot_id: snapshotId, build_id: build?.build_id ?? null,
        resource_type: 'snapshot_image', provider_resource_id: snapshotRow.provider_image_id,
        provenance_key: `snapshot:${snapshotId}`, reason, status: 'queued', attempts: 0,
        next_attempt_at: now, lease_expires_at: null, last_error_code: null,
        created_at: now, completed_at: null,
      }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
        .where('completed_at', 'is', null).doNothing()).execute();
    }
    const updated = await trx.executor.updateTable('golden_snapshots').set({
      state: 'retiring', retiring_at: now, updated_at: now, revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshotId).where('revision', '=', snapshotRow.revision)
      .returning('snapshot_id').executeTakeFirst();
    if (updated) {
      await appendGoldenSnapshotAuditEvent(trx, {
        snapshotId, eventType: 'snapshot_retiring', actorType: 'operator',
        fromState: snapshotRow.state, toState: 'retiring', reason, now,
      });
    }
    return updated !== undefined;
  });
}

export async function enforceGoldenSnapshotRetention(
  db: PlatformDB,
  rawInput: z.input<typeof RetentionInputSchema>,
): Promise<{ retiredSnapshotIds: string[]; blocked: boolean }> {
  const input = RetentionInputSchema.parse(rawInput);
  await db.ready;
  try {
    await reconcileExpiredGoldenSnapshotLeases(db, input.now, 100);
  } catch (err: unknown) {
    console.error(`[golden-snapshot] lease reconciliation failed: ${err instanceof Error ? err.name : typeof err}`);
  }
  const [readyRows, disposableRows, channels] = await Promise.all([
    db.executor.selectFrom('golden_snapshots').select([
      'snapshot_id', 'bundle_version', 'compatibility_key', 'ready_at',
    ]).where('state', '=', 'ready').orderBy('ready_at', 'desc').limit(100).execute(),
    db.executor.selectFrom('golden_snapshots').select('snapshot_id')
      .where('state', 'in', ['failed', 'quarantined']).where('provider_image_id', 'is not', null)
      .orderBy('updated_at').limit(100).execute(),
    db.executor.selectFrom('host_bundle_channels').select(['channel', 'version']).limit(20).execute(),
  ]);
  const candidateSnapshotIds = [...new Set([
    ...readyRows.map((row) => row.snapshot_id), ...disposableRows.map((row) => row.snapshot_id),
  ])];
  const activeLeases = candidateSnapshotIds.length === 0 ? [] : await db.executor
    .selectFrom('golden_snapshot_leases').select('snapshot_id')
    .where('released_at', 'is', null)
    .where('snapshot_id', 'in', candidateSnapshotIds).execute();
  const channelHistory = (await Promise.all(channels.map((current) =>
    db.executor.selectFrom('host_bundle_release_channels').select(['channel', 'version', 'promoted_at'])
      .where('channel', '=', current.channel).orderBy('promoted_at', 'desc')
      .limit(input.rollbackVersionsPerChannel + 1).execute()))).flat();
  const targetCount = input.quotaPressure ? Math.max(0, input.retentionLimit - 1) : input.retentionLimit;
  const freshnessCutoff = input.freshnessMaxAgeMs === undefined
    ? undefined
    : new Date(new Date(input.now).getTime() - input.freshnessMaxAgeMs).toISOString();
  const freshnessExpired = new Set(readyRows
    .filter((row) => freshnessCutoff !== undefined && row.ready_at !== null && row.ready_at <= freshnessCutoff)
    .map((row) => row.snapshot_id));
  const retirementCount = Math.max(0, readyRows.length - freshnessExpired.size - targetCount);

  const protectedVersions = new Set(channels.map((row) => row.version));
  const currentByChannel = new Map(channels.map((row) => [row.channel, row.version]));
  const rollbackCount = new Map<string, number>();
  for (const row of channelHistory) {
    if (currentByChannel.get(row.channel) === row.version) continue;
    const count = rollbackCount.get(row.channel) ?? 0;
    if (count >= input.rollbackVersionsPerChannel) continue;
    protectedVersions.add(row.version);
    rollbackCount.set(row.channel, count + 1);
  }
  const protectedSnapshots = new Set(activeLeases.map((row) => row.snapshot_id));
  const newestByCompatibility = new Map<string, string>();
  for (const row of readyRows) {
    if (freshnessExpired.has(row.snapshot_id)) continue;
    if (!newestByCompatibility.has(row.compatibility_key)) {
      newestByCompatibility.set(row.compatibility_key, row.snapshot_id);
      protectedSnapshots.add(row.snapshot_id);
    }
  }

  const freshnessCandidates = [...readyRows].reverse().filter((row) =>
    freshnessExpired.has(row.snapshot_id) && !protectedSnapshots.has(row.snapshot_id));
  const candidates = [...readyRows].reverse().filter((row) =>
    !freshnessExpired.has(row.snapshot_id)
    && !protectedSnapshots.has(row.snapshot_id)
    && !protectedVersions.has(row.bundle_version));
  const retiredSnapshotIds: string[] = [];
  const tryRetire = async (snapshotId: string, reason: string): Promise<boolean> => {
    try {
      return await retireGoldenSnapshot(db, snapshotId, reason, input.now, {
        rollbackVersionsPerChannel: input.rollbackVersionsPerChannel,
        freshnessMaxAgeMs: input.freshnessMaxAgeMs,
      });
    } catch (err: unknown) {
      console.error(
        `[golden-snapshot] retention failed snapshot=${snapshotId}: ${err instanceof Error ? err.name : typeof err}`,
      );
      return false;
    }
  };
  for (const disposable of disposableRows) {
    if (await tryRetire(disposable.snapshot_id, 'invalid_snapshot_cleanup')) {
      retiredSnapshotIds.push(disposable.snapshot_id);
    }
  }
  for (const stale of freshnessCandidates) {
    if (await tryRetire(stale.snapshot_id, 'freshness_expired')) {
      retiredSnapshotIds.push(stale.snapshot_id);
    }
  }
  for (const candidate of candidates.slice(0, retirementCount)) {
    if (await tryRetire(candidate.snapshot_id, input.quotaPressure ? 'quota_pressure' : 'retention')) {
      retiredSnapshotIds.push(candidate.snapshot_id);
    }
  }
  return {
    retiredSnapshotIds,
    blocked: retiredSnapshotIds.length < disposableRows.length + freshnessCandidates.length + retirementCount,
  };
}

export async function listGoldenSnapshotOperationalStatus(
  db: PlatformDB,
  rawLimit: number,
): Promise<Array<{
  snapshotId: string;
  bundleVersion: string;
  state: GoldenSnapshotState;
  failureCode: string | null;
  updatedAt: string;
}>> {
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  const rows = await db.executor.selectFrom('golden_snapshots').select([
    'snapshot_id', 'bundle_version', 'state', 'failure_code', 'updated_at',
  ]).orderBy('updated_at', 'desc').limit(limit).execute();
  return rows.map((row) => ({
    snapshotId: UuidSchema.parse(row.snapshot_id),
    bundleVersion: z.string().min(1).max(128).parse(row.bundle_version),
    state: GoldenSnapshotStateSchema.parse(row.state),
    failureCode: row.failure_code === null ? null : BoundedCodeSchema.parse(row.failure_code),
    updatedAt: IsoDateSchema.parse(row.updated_at),
  }));
}

export async function retryGoldenSnapshotBuild(
  db: PlatformDB,
  rawBuildId: string,
  rawNow: string,
): Promise<boolean> {
  const buildId = UuidSchema.parse(rawBuildId);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction(async (trx) => {
    const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
      .where('build_id', '=', buildId).forUpdate().executeTakeFirst();
    if (!build || build.status !== 'failed') return false;
    const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', build.snapshot_id).forUpdate().executeTakeFirst();
    if (!snapshot || snapshot.state !== 'failed' || snapshot.provider_image_id !== null) return false;
    const updatedSnapshot = await trx.executor.updateTable('golden_snapshots').set({
      state: 'candidate', failure_code: null, updated_at: now,
      revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshot.snapshot_id).where('revision', '=', snapshot.revision)
      .returning('snapshot_id').executeTakeFirst();
    if (!updatedSnapshot) return false;
    const staleResources = [
      build.provider_builder_id === null ? undefined : {
        type: 'builder_server' as const, id: build.provider_builder_id,
      },
      build.provider_validation_id === null ? undefined : {
        type: 'validation_server' as const, id: build.provider_validation_id,
      },
    ].filter((resource): resource is {
      type: 'builder_server' | 'validation_server'; id: number;
    } => resource !== undefined);
    for (const resource of staleResources) {
      await trx.executor.insertInto('golden_snapshot_cleanup').values({
        cleanup_id: randomUUID(), snapshot_id: snapshot.snapshot_id, build_id: buildId,
        resource_type: resource.type, provider_resource_id: resource.id,
        provenance_key: `build:${buildId}:${resource.type}`, reason: 'operator_retry',
        status: 'queued', attempts: 0, next_attempt_at: now, lease_expires_at: null,
        last_error_code: null, created_at: now, completed_at: null,
      }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
        .where('completed_at', 'is', null).doNothing()).execute();
    }
    await trx.executor.updateTable('golden_snapshot_builds').set({
      phase: 'requested', status: 'queued', available_at: now, claimed_at: null,
      lease_expires_at: null, last_error_code: null, attempts: 0,
      provider_builder_id: null, provider_builder_action_id: null, provider_snapshot_action_id: null,
      provider_validation_id: null, provider_validation_action_id: null,
      callback_phase: null, callback_token_hash: null, callback_expires_at: null,
      pending_operation: null,
      updated_at: now, completed_at: null,
    }).where('build_id', '=', buildId).where('status', '=', 'failed').executeTakeFirstOrThrow();
    return true;
  });
}

export async function listPendingGoldenSnapshotCleanup(
  db: PlatformDB, rawNow: string, rawLimit: number,
): Promise<GoldenSnapshotCleanupRecord[]> {
  const now = IsoDateSchema.parse(rawNow);
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  const rows = await db.executor.selectFrom('golden_snapshot_cleanup').selectAll()
    .where('completed_at', 'is', null).where('next_attempt_at', '<=', now)
    .where((eb) => eb.or([eb('status', '=', 'queued'), eb.and([
      eb('status', '=', 'running'), eb('lease_expires_at', '<=', now),
    ])])).orderBy('created_at').limit(limit).execute();
  return rows.map(mapCleanup);
}

export async function retryGoldenSnapshotCleanup(
  db: PlatformDB,
  rawCleanupId: string,
  rawNow: string,
): Promise<boolean> {
  const cleanupId = UuidSchema.parse(rawCleanupId);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction(async (trx) => {
    const row = await trx.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'queued', attempts: 0, next_attempt_at: now,
      lease_expires_at: null, last_error_code: null,
    }).where('cleanup_id', '=', cleanupId)
      .where('completed_at', 'is', null)
      .where('status', 'in', ['failed', 'quarantined'])
      .returning(['cleanup_id', 'snapshot_id', 'build_id'])
      .executeTakeFirst();
    if (!row) return false;
    await appendGoldenSnapshotAuditEvent(trx, {
      snapshotId: row.snapshot_id, buildId: row.build_id, cleanupId: row.cleanup_id,
      eventType: 'cleanup_retried', actorType: 'operator', now,
    });
    return true;
  });
}

export async function pruneGoldenSnapshotAuditEvents(
  db: PlatformDB,
  rawBefore: string,
  rawLimit: number,
): Promise<number> {
  const before = IsoDateSchema.parse(rawBefore);
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  return db.transaction(async (trx) => {
    const rows = await trx.executor.selectFrom('golden_snapshot_audit_events')
      .select('event_id').where('created_at', '<', before)
      .orderBy('created_at').orderBy('event_id').forUpdate().skipLocked().limit(limit).execute();
    if (rows.length === 0) return 0;
    const deleted = await trx.executor.deleteFrom('golden_snapshot_audit_events')
      .where('event_id', 'in', rows.map((row) => row.event_id)).returning('event_id').execute();
    return deleted.length;
  });
}
