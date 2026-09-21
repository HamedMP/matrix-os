/**
 * Golden snapshot build queue persistence.
 *
 * Extracted from ../golden-snapshot-repository.ts (Phase 1-A4). Pure move: no logic changes.
 */
import {

  mapBuild,
  mapCleanup,
  mapCreateIntent,
  mapLease,
  mapRolloutControl,
  mapSnapshot,
} from './mappers.js';
import {
  decodeGoldenSnapshotAffectedMachineCursor,
  decodeGoldenSnapshotOperationalCursor,
  encodeGoldenSnapshotAffectedMachineCursor,
  encodeGoldenSnapshotOperationalCursor,
  type GoldenSnapshotAffectedMachine,
  type GoldenSnapshotAffectedMachineCursor,
  type GoldenSnapshotBuildRecord,
  type GoldenSnapshotCleanupRecord,
  type GoldenSnapshotCreateIntentRecord,
  type GoldenSnapshotLeaseRecord,
  type GoldenSnapshotOperationalCursor,
  type GoldenSnapshotRecord,
  type GoldenSnapshotRolloutControlRecord,
} from './schemas.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

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

import { z } from 'zod/v4';
import {
  EnqueueInputSchema,
  GoldenSnapshotBuildRequiresRetryError,
  IsoDateSchema,
  RegisteredReleaseSha256Schema,
  UuidSchema,
  ValidationReservationInputSchema,
} from './schemas.js';
import {
  appendGoldenSnapshotAuditEvent,
} from './lifecycle.js';

export async function enqueueGoldenSnapshotBuild(
  db: PlatformDB,
  rawInput: z.input<typeof EnqueueInputSchema>,
): Promise<{ snapshot: GoldenSnapshotRecord; build: GoldenSnapshotBuildRecord; reused: boolean }> {
  await db.ready;
  return db.transaction((trx) => enqueueGoldenSnapshotBuildInTransaction(trx, rawInput));
}


export async function enqueueGoldenSnapshotBuildInTransaction(
  trx: PlatformDB,
  rawInput: z.input<typeof EnqueueInputSchema>,
): Promise<{ snapshot: GoldenSnapshotRecord; build: GoldenSnapshotBuildRecord; reused: boolean }> {
    const input = EnqueueInputSchema.parse(rawInput);
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
    const latestSnapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('bundle_sha256', '=', bundleSha256).where('compatibility_key', '=', key)
      .where('test_mode', '=', input.testMode)
      .orderBy('image_generation', 'desc').forUpdate().executeTakeFirst();
    const createReplacement = latestSnapshot === undefined
      || latestSnapshot.state === 'retiring'
      || latestSnapshot.state === 'deleted'
      || (input.replaceReady && latestSnapshot.state === 'ready');
    const imageGeneration = createReplacement ? (latestSnapshot?.image_generation ?? 0) + 1 : latestSnapshot.image_generation;
    const insertedSnapshot = createReplacement
      ? await trx.executor.insertInto('golden_snapshots').values({
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
      image_generation: imageGeneration,
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
    }).onConflict((oc) => oc.columns([
      'bundle_sha256', 'compatibility_key', 'test_mode', 'image_generation',
    ]).doNothing()).returningAll().executeTakeFirst()
      : undefined;
    const snapshotRow = insertedSnapshot ?? latestSnapshot ?? await trx.executor.selectFrom('golden_snapshots')
      .selectAll().where('bundle_sha256', '=', bundleSha256).where('compatibility_key', '=', key)
      .where('test_mode', '=', input.testMode)
      .where('image_generation', '=', imageGeneration)
      .executeTakeFirstOrThrow();
    const snapshot = mapSnapshot(snapshotRow);
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
}


async function countGoldenSnapshotInfrastructure(
  trx: PlatformDB,
): Promise<number> {
  const active = await sql<{ count: number | string }>`
    SELECT COALESCE(SUM(GREATEST(
      CASE
        WHEN phase = 'validation_create'
          AND provider_builder_id IS NULL
          AND provider_validation_id IS NULL
          AND pending_operation IS NULL
        THEN 0
        ELSE 1
      END,
      (CASE WHEN provider_builder_id IS NOT NULL OR pending_operation LIKE 'builder:%' THEN 1 ELSE 0 END)
      + (CASE WHEN provider_validation_id IS NOT NULL OR pending_operation LIKE 'validation:%' THEN 1 ELSE 0 END)
    )), 0) AS count
    FROM golden_snapshot_builds
    WHERE status = 'running'
  `.execute(trx.executor);
  const cleanup = await trx.executor.selectFrom('golden_snapshot_cleanup')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('resource_type', 'in', ['builder_server', 'validation_server'])
    .where('completed_at', 'is', null).executeTakeFirstOrThrow();
  return Number(active.rows[0]?.count ?? 0) + Number(cleanup.count);
}


export async function reserveGoldenSnapshotValidationCreate(
  db: PlatformDB,
  rawInput: z.input<typeof ValidationReservationInputSchema>,
): Promise<boolean> {
  const input = ValidationReservationInputSchema.parse(rawInput);
  if (input.callbackExpiresAt <= input.now) throw new Error('Validation callback deadline must be in the future');
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('golden_snapshot_build_capacity'))`
      .execute(trx.executor);
    if (await countGoldenSnapshotInfrastructure(trx) >= input.maxResources) return false;
    const reserved = await trx.executor.updateTable('golden_snapshot_builds').set({
      pending_operation: `validation:${input.buildId}:${input.validationOrdinal}`,
      callback_phase: 'validated', callback_token_hash: input.callbackTokenHash,
      callback_expires_at: input.callbackExpiresAt, updated_at: input.now,
    }).where('build_id', '=', input.buildId).where('phase', '=', 'validation_create')
      .where('validation_clone_ordinal', '=', input.validationOrdinal)
      .where('callback_token_hash', 'is', null).where('pending_operation', 'is', null)
      .returning('build_id').executeTakeFirst();
    return reserved !== undefined;
  });
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
    if (await terminalizeExhaustedGoldenSnapshotBuild(trx, buildId, now, maxAttempts)) {
      return undefined;
    }
    const reclaimable = await trx.executor.selectFrom('golden_snapshot_builds')
      .select('build_id')
      .where('build_id', '=', buildId)
      .where('status', '=', 'running')
      .where((eb) => eb.or([
        eb('attempts', '<', maxAttempts),
        eb('phase', '=', 'snapshot_wait'),
      ]))
      .where('lease_expires_at', '<=', now)
      .where((eb) => eb.or([
        eb('phase', 'not in', ['builder_boot', 'validation_boot']),
        eb('callback_expires_at', 'is', null),
        eb('callback_expires_at', '<=', now),
      ]))
      .forUpdate()
      .executeTakeFirst();
    if (!reclaimable && await countGoldenSnapshotInfrastructure(trx) >= maxConcurrent) {
      return undefined;
    }
    const row = await trx.executor.updateTable('golden_snapshot_builds').set({
      status: 'running',
      attempts: sql<number>`CASE WHEN phase = 'snapshot_wait' THEN attempts ELSE attempts + 1 END`,
      claimed_at: now,
      lease_expires_at: leaseExpiresAt, updated_at: now,
    }).where('build_id', '=', buildId).where((eb) => eb.or([
      eb('attempts', '<', maxAttempts),
      eb('phase', '=', 'snapshot_wait'),
    ]))
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
    .where('phase', '!=', 'snapshot_wait')
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
      .where('phase', '!=', 'snapshot_wait')
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
    const reclaimable = await trx.executor.selectFrom('golden_snapshot_builds')
      .select('build_id')
      .where((eb) => eb.or([
        eb('attempts', '<', maxAttempts),
        eb('phase', '=', 'snapshot_wait'),
      ]))
      .where('phase', 'not in', ['builder_boot', 'validation_boot'])
      .where((eb) => eb.exists(
        eb.selectFrom('golden_snapshots').select('snapshot_id')
          .whereRef('golden_snapshots.snapshot_id', '=', 'golden_snapshot_builds.snapshot_id')
          .where('golden_snapshots.state', 'in', ['candidate', 'building', 'sanitizing', 'validating']),
      ))
      .where((eb) => eb.exists(
        eb.selectFrom('golden_snapshots')
          .leftJoin('host_bundle_releases', 'host_bundle_releases.version', 'golden_snapshots.bundle_version')
          .leftJoin('host_bundle_channels', (join) => join
            .onRef('host_bundle_channels.version', '=', 'host_bundle_releases.version')
            .on('host_bundle_channels.channel', '=', 'stable'))
          .select('golden_snapshots.snapshot_id')
          .whereRef('golden_snapshots.snapshot_id', '=', 'golden_snapshot_builds.snapshot_id')
          .where((snapshotEb) => snapshotEb.or([
            snapshotEb('golden_snapshots.test_mode', '=', true),
            snapshotEb.and([
              snapshotEb('host_bundle_releases.snapshot_eligible', '=', true),
              snapshotEb('host_bundle_channels.channel', '=', 'stable'),
            ]),
          ])),
      ))
      .where('status', '=', 'running')
      .where('lease_expires_at', '<=', now)
      .where((eb) => eb.or([
        eb('phase', 'not in', ['builder_boot', 'validation_boot']),
        eb('callback_expires_at', 'is', null),
        eb('callback_expires_at', '<=', now),
      ]))
      .orderBy('available_at')
      .orderBy('build_id')
      .forUpdate()
      .skipLocked()
      .limit(limit)
      .execute();
    const claimed: GoldenSnapshotBuildRecord[] = [];
    for (const candidate of reclaimable) {
      const row = await trx.executor.updateTable('golden_snapshot_builds').set({
        status: 'running',
        attempts: sql<number>`CASE WHEN phase = 'snapshot_wait' THEN attempts ELSE attempts + 1 END`,
        claimed_at: now,
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      }).where('build_id', '=', candidate.build_id)
        .where((eb) => eb.or([
          eb('attempts', '<', maxAttempts),
          eb('phase', '=', 'snapshot_wait'),
        ]))
        .where('phase', 'not in', ['builder_boot', 'validation_boot'])
        .where('status', '=', 'running')
        .where('lease_expires_at', '<=', now)
        .returningAll()
        .executeTakeFirst();
      if (row) claimed.push(mapBuild(row));
    }
    const capacity = Math.min(
      limit - claimed.length,
      Math.max(0, maxConcurrent - await countGoldenSnapshotInfrastructure(trx)),
    );
    if (capacity === 0) return claimed;
    const queued = await trx.executor.selectFrom('golden_snapshot_builds')
      .select('build_id')
      .where('attempts', '<', maxAttempts)
      .where((eb) => eb.exists(
        eb.selectFrom('golden_snapshots').select('snapshot_id')
          .whereRef('golden_snapshots.snapshot_id', '=', 'golden_snapshot_builds.snapshot_id')
          .where('golden_snapshots.state', 'in', ['candidate', 'building', 'sanitizing', 'validating']),
      ))
      .where((eb) => eb.exists(
        eb.selectFrom('golden_snapshots')
          .leftJoin('host_bundle_releases', 'host_bundle_releases.version', 'golden_snapshots.bundle_version')
          .leftJoin('host_bundle_channels', (join) => join
            .onRef('host_bundle_channels.version', '=', 'host_bundle_releases.version')
            .on('host_bundle_channels.channel', '=', 'stable'))
          .select('golden_snapshots.snapshot_id')
          .whereRef('golden_snapshots.snapshot_id', '=', 'golden_snapshot_builds.snapshot_id')
          .where((snapshotEb) => snapshotEb.or([
            snapshotEb('golden_snapshots.test_mode', '=', true),
            snapshotEb.and([
              snapshotEb('host_bundle_releases.snapshot_eligible', '=', true),
              snapshotEb('host_bundle_channels.channel', '=', 'stable'),
            ]),
          ])),
      ))
      .where('status', '=', 'queued')
      .where('available_at', '<=', now)
      .orderBy('available_at')
      .orderBy('build_id')
      .forUpdate()
      .skipLocked()
      .limit(capacity)
      .execute();
    for (const candidate of queued) {
      const row = await trx.executor.updateTable('golden_snapshot_builds').set({
        status: 'running',
        attempts: sql<number>`attempts + 1`,
        claimed_at: now,
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      }).where('build_id', '=', candidate.build_id)
        .where('attempts', '<', maxAttempts)
        .where('phase', 'not in', ['builder_boot', 'validation_boot'])
        .where('status', '=', 'queued')
        .where('available_at', '<=', now)
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
      .where((eb) => eb.exists(
        eb.selectFrom('golden_snapshots')
          .leftJoin('host_bundle_releases', 'host_bundle_releases.version', 'golden_snapshots.bundle_version')
          .leftJoin('host_bundle_channels', (join) => join
            .onRef('host_bundle_channels.version', '=', 'host_bundle_releases.version')
            .on('host_bundle_channels.channel', '=', 'stable'))
          .select('golden_snapshots.snapshot_id')
          .whereRef('golden_snapshots.snapshot_id', '=', 'golden_snapshot_builds.snapshot_id')
          .where((snapshotEb) => snapshotEb.or([
            snapshotEb('golden_snapshots.test_mode', '=', true),
            snapshotEb.and([
              snapshotEb('host_bundle_releases.snapshot_eligible', '=', true),
              snapshotEb('host_bundle_channels.channel', '=', 'stable'),
            ]),
          ])),
      ))
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
    if (!snapshot || !['failed', 'quarantined'].includes(snapshot.state)
      || snapshot.provider_image_id !== null) return false;
    // A pending operation is an unresolved provider-side create. Retrying here
    // would erase the exact-label reconciliation marker and could duplicate the
    // builder. Reconciliation must first prove adoption or exact absence.
    if (build.pending_operation !== null) return false;
    const cleanupRows = await trx.executor.selectFrom('golden_snapshot_cleanup')
      .select(['resource_type', 'provider_resource_id', 'completed_at'])
      .where('snapshot_id', '=', snapshot.snapshot_id).execute();
    if (cleanupRows.some((row) => row.completed_at === null)) return false;
    const completedCleanup = new Set(cleanupRows
      .filter((row) => row.completed_at !== null)
      .map((row) => `${row.resource_type}:${row.provider_resource_id}`));
    const staleResources = [
      build.provider_builder_id === null ? undefined : {
        type: 'builder_server' as const, id: build.provider_builder_id,
      },
      build.provider_validation_id === null ? undefined : {
        type: 'validation_server' as const, id: build.provider_validation_id,
      },
    ].filter((resource): resource is {
      type: 'builder_server' | 'validation_server'; id: number;
    } => resource !== undefined && !completedCleanup.has(`${resource.type}:${resource.id}`));
    if (staleResources.length > 0) {
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
      return false;
    }
    const updatedSnapshot = await trx.executor.updateTable('golden_snapshots').set({
      state: 'candidate', failure_code: null, updated_at: now,
      revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshot.snapshot_id).where('revision', '=', snapshot.revision)
      .returning('snapshot_id').executeTakeFirst();
    if (!updatedSnapshot) return false;
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
