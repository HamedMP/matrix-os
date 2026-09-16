/**
 * Golden snapshot core persistence (get/advance/image/ready/recovery/affected/status).
 *
 * Extracted from ../golden-snapshot-repository.ts (Phase 1-A4). Pure move: no logic changes.
 */
import {
  appendGoldenSnapshotAuditEvent,
} from './lifecycle.js';
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
  AffectedMachinePageInputSchema,
  BoundedCodeSchema,
  IsoDateSchema,
  OperationalStatusPageInputSchema,
  ProviderImageInputSchema,
  RetentionInputSchema,
  RetirementPolicySchema,
  Sha256Schema,
  UuidSchema,
} from './schemas.js';
import {
  reconcileExpiredGoldenSnapshotLeases,
} from './leases.js';

type AuditActor = 'release' | 'worker' | 'operator';

export async function getGoldenSnapshot(db: PlatformDB, rawSnapshotId: string): Promise<GoldenSnapshotRecord | undefined> {
  const snapshotId = UuidSchema.parse(rawSnapshotId);
  await db.ready;
  const row = await db.executor.selectFrom('golden_snapshots').selectAll().where('snapshot_id', '=', snapshotId).executeTakeFirst();
  return row ? mapSnapshot(row) : undefined;
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
      if (build?.status === 'running') {
        await trx.executor.updateTable('golden_snapshot_builds').set({
          phase: 'failed', status: 'failed', last_error_code: 'provider_image_metadata_conflict',
          lease_expires_at: null, callback_phase: null, callback_token_hash: null,
          callback_expires_at: null, pending_operation: null,
          completed_at: input.now, updated_at: input.now,
        }).where('build_id', '=', build.build_id).where('status', '=', 'running').execute();
        const resources = [
          build.provider_builder_id === null ? undefined : {
            type: 'builder_server' as const, id: Number(build.provider_builder_id),
          },
          build.provider_validation_id === null ? undefined : {
            type: 'validation_server' as const, id: Number(build.provider_validation_id),
          },
        ].filter((resource): resource is {
          type: 'builder_server' | 'validation_server'; id: number;
        } => resource !== undefined);
        for (const resource of resources) {
          await trx.executor.insertInto('golden_snapshot_cleanup').values({
            cleanup_id: randomUUID(), snapshot_id: snapshotId, build_id: build.build_id,
            resource_type: resource.type, provider_resource_id: resource.id,
            provenance_key: `build:${build.build_id}:${resource.type}`,
            reason: 'provider_image_metadata_conflict', status: 'queued', attempts: 0,
            next_attempt_at: input.now, lease_expires_at: null, last_error_code: null,
            created_at: input.now, completed_at: null,
          }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
            .where('completed_at', 'is', null).doNothing()).execute();
        }
      }
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


async function listGoldenSnapshotAffectedMachinesForScope(
  db: PlatformDB,
  scope: { baseGeneration: string } | { snapshotId: string },
  input: z.infer<typeof AffectedMachinePageInputSchema>,
): Promise<{
  machines: GoldenSnapshotAffectedMachine[];
  nextCursor?: GoldenSnapshotAffectedMachineCursor;
}> {
  // user_machines.provisioned_at is TEXT NOT NULL. Coalescing each optional
  // activity timestamp to that durable floor keeps GREATEST non-null while
  // still selecting the newest lifecycle timestamp.
  const updatedAt = sql<string>`GREATEST(
    COALESCE(last_seen_at, provisioned_at),
    COALESCE(failure_at, provisioned_at),
    COALESCE(resize_started_at, provisioned_at)
  )`;
  await db.ready;
  let query = db.executor.selectFrom('user_machines').select([
    'machine_id', 'runtime_slot', 'source_snapshot_id', 'target_bundle_version', 'status',
    updatedAt.as('provenance_updated_at'),
  ])
    .where('source_snapshot_id', 'is not', null)
    .where('target_bundle_version', 'is not', null)
    .where('deleted_at', 'is', null)
    .where('status', 'in', ['running', 'recovering', 'resizing']);
  query = 'baseGeneration' in scope
    ? query.where('source_base_generation', '=', scope.baseGeneration)
    : query.where('source_snapshot_id', '=', scope.snapshotId);
  if (input.cursor) {
    query = query.where('machine_id', '>', input.cursor.machineId);
  }
  const rows = await query.orderBy('machine_id').limit(input.limit + 1).execute();
  const pageRows = rows.slice(0, input.limit);
  const machines = pageRows.map((row): GoldenSnapshotAffectedMachine => {
    if (!row.source_snapshot_id || !row.target_bundle_version) {
      throw new Error('Affected machine provenance is incomplete');
    }
    return {
      machineId: UuidSchema.parse(row.machine_id),
      runtimeSlot: z.string().min(1).max(32).parse(row.runtime_slot),
      sourceSnapshotId: UuidSchema.parse(row.source_snapshot_id),
      targetBundleVersion: GoldenSnapshotBundleVersionSchema.parse(row.target_bundle_version),
      status: z.enum(['running', 'recovering', 'resizing']).parse(row.status),
      updatedAt: IsoDateSchema.parse(row.provenance_updated_at),
    };
  });
  const last = machines.at(-1);
  return {
    machines,
    ...(rows.length > input.limit && last ? {
      nextCursor: { machineId: last.machineId },
    } : {}),
  };
}


export async function listGoldenSnapshotAffectedMachines(
  db: PlatformDB,
  rawBaseGeneration: string,
  rawInput: z.input<typeof AffectedMachinePageInputSchema>,
): Promise<{
  machines: GoldenSnapshotAffectedMachine[];
  nextCursor?: GoldenSnapshotAffectedMachineCursor;
}> {
  return listGoldenSnapshotAffectedMachinesForScope(
    db,
    { baseGeneration: GoldenSnapshotBaseGenerationSchema.parse(rawBaseGeneration) },
    AffectedMachinePageInputSchema.parse(rawInput),
  );
}


export async function listGoldenSnapshotAffectedMachinesBySnapshot(
  db: PlatformDB,
  rawSnapshotId: string,
  rawInput: z.input<typeof AffectedMachinePageInputSchema>,
): Promise<{
  machines: GoldenSnapshotAffectedMachine[];
  nextCursor?: GoldenSnapshotAffectedMachineCursor;
}> {
  return listGoldenSnapshotAffectedMachinesForScope(
    db,
    { snapshotId: UuidSchema.parse(rawSnapshotId) },
    AffectedMachinePageInputSchema.parse(rawInput),
  );
}


export async function listGoldenSnapshotOperationalStatus(
  db: PlatformDB,
  rawInput: z.input<typeof OperationalStatusPageInputSchema>,
): Promise<{
  snapshots: Array<{
  snapshotId: string;
  bundleVersion: string;
  state: GoldenSnapshotState;
  failureCode: string | null;
  updatedAt: string;
  }>;
  nextCursor?: GoldenSnapshotOperationalCursor;
}> {
  const input = OperationalStatusPageInputSchema.parse(rawInput);
  await db.ready;
  let query = db.executor.selectFrom('golden_snapshots').select([
    'snapshot_id', 'bundle_version', 'state', 'failure_code', 'created_at', 'updated_at',
  ]);
  if (input.cursor) {
    query = query.where((eb) => eb.or([
      eb('created_at', '<', input.cursor!.createdAt),
      eb.and([
        eb('created_at', '=', input.cursor!.createdAt),
        eb('snapshot_id', '<', input.cursor!.snapshotId),
      ]),
    ]));
  }
  const rows = await query.orderBy('created_at', 'desc').orderBy('snapshot_id', 'desc')
    .limit(input.limit + 1).execute();
  const pageRows = rows.slice(0, input.limit);
  const snapshots = pageRows.map((row) => ({
    snapshotId: UuidSchema.parse(row.snapshot_id),
    bundleVersion: z.string().min(1).max(128).parse(row.bundle_version),
    state: GoldenSnapshotStateSchema.parse(row.state),
    failureCode: row.failure_code === null ? null : BoundedCodeSchema.parse(row.failure_code),
    updatedAt: IsoDateSchema.parse(row.updated_at),
  }));
  const last = pageRows.at(-1);
  return {
    snapshots,
    ...(rows.length > input.limit && last
      ? {
          nextCursor: {
            createdAt: IsoDateSchema.parse(last.created_at),
            snapshotId: UuidSchema.parse(last.snapshot_id),
          },
        }
      : {}),
  };
}
