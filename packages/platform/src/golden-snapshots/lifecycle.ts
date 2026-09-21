/**
 * Golden snapshot revocation, retirement, retention, and audit.
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
    // Do not infer provider completion from time alone: only an explicit release
    // after durable workflow/provider reconciliation permits image cleanup.
    const unreleasedLease = await trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
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
      snapshot.provider_image_id === null || unreleasedLease ? undefined : {
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


export async function listRevokedGoldenSnapshotBaseGenerations(
  db: PlatformDB,
  rawLimit = 25,
): Promise<string[]> {
  const limit = z.number().int().min(1).max(100).parse(rawLimit);
  await db.ready;
  const rows = await db.executor.selectFrom('golden_snapshot_revoked_base_generations')
    .select('base_generation')
    .where(({ exists, selectFrom }) => exists(
      selectFrom('golden_snapshots').select('snapshot_id')
        .whereRef(
          'golden_snapshots.base_generation',
          '=',
          'golden_snapshot_revoked_base_generations.base_generation',
        )
        .where('golden_snapshots.state', 'in', [
          'candidate', 'building', 'sanitizing', 'validating', 'ready', 'failed',
        ]),
    ))
    .orderBy('updated_at')
    .orderBy('base_generation')
    .limit(limit)
    .execute();
  return rows.map((row) => GoldenSnapshotBaseGenerationSchema.parse(row.base_generation));
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
    await trx.executor.updateTable('golden_snapshot_revoked_base_generations')
      .set({ updated_at: now })
      .where('base_generation', '=', baseGeneration)
      .execute();
    // Expired rows stay in this set until reconciliation proves the associated
    // provisioning/recovery workflow terminal and writes released_at.
    const snapshotsWithUnreleasedLeases = new Set((await trx.executor.selectFrom('golden_snapshot_leases')
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
        snapshot.provider_image_id === null || snapshotsWithUnreleasedLeases.has(snapshot.snapshot_id) ? undefined : {
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
    await sql`SELECT pg_advisory_xact_lock(hashtext(${retirementTarget.base_generation}))`
      .execute(trx.executor);
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
    const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
      .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
    // An unresolved provider create must be reconciled before retirement. Its
    // exact resource may not be represented by any persisted provider ID yet.
    if (build?.pending_operation !== null && build?.pending_operation !== undefined) return false;
    const freshnessExpired = snapshotRow.state === 'ready'
      && policy.freshnessMaxAgeMs !== undefined
      && snapshotRow.ready_at !== null
      && new Date(snapshotRow.ready_at).getTime() <= new Date(now).getTime() - policy.freshnessMaxAgeMs;
    const release = await trx.executor.selectFrom('host_bundle_releases').select('version')
      .where('version', '=', snapshotRow.bundle_version).forUpdate().executeTakeFirst();
    if (!release) return false;
    // Expiry makes a lease eligible for reconciliation; it does not prove that
    // the provider clone is terminal. Every unreleased lease therefore remains
    // a deletion barrier until the workflow/reconciler releases it durably.
    const unreleasedLease = await trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
      .where('snapshot_id', '=', snapshotId).where('released_at', 'is', null)
      .executeTakeFirst();
    if (unreleasedLease) return false;
    // Channel promotion to this bundle locks the same immutable release row
    // before changing either channel table. Holding that row lock makes these
    // current/rollback guard reads atomic with every promotion to this version;
    // row-locking only existing channel rows would not protect an absent row.
    const currentChannel = await trx.executor.selectFrom('host_bundle_channels').select('channel')
      .where('version', '=', snapshotRow.bundle_version).executeTakeFirst();
    let rollbackProtected = false;
    if (snapshotRow.state === 'ready' && policy.rollbackVersionsPerChannel > 0) {
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
      rollbackProtected = rollbackReference.rows.length > 0;
    }
    if (snapshotRow.state === 'ready' && (currentChannel || rollbackProtected)) {
      if (!freshnessExpired) return false;
      const readyReplacement = compatibilityRows.find((row) => row
        && row.snapshot_id !== snapshotId
        && row.bundle_sha256 === snapshotRow.bundle_sha256
        && row.ready_at !== null
        && snapshotRow.ready_at !== null
        && row.ready_at > snapshotRow.ready_at);
      if (!readyReplacement) return false;
    }
    if (snapshotRow.state === 'ready' && !freshnessExpired) {
      const otherReady = compatibilityRows.find((row) => row?.snapshot_id !== snapshotId);
      if (!otherReady) return false;
    }
    const resources = [
      build?.provider_builder_id === null || build?.provider_builder_id === undefined ? undefined : {
        type: 'builder_server' as const, id: build.provider_builder_id,
      },
      build?.provider_validation_id === null || build?.provider_validation_id === undefined ? undefined : {
        type: 'validation_server' as const, id: build.provider_validation_id,
      },
      snapshotRow.provider_image_id === null ? undefined : {
        type: 'snapshot_image' as const, id: snapshotRow.provider_image_id,
      },
    ].filter((resource): resource is {
      type: 'builder_server' | 'validation_server' | 'snapshot_image'; id: number;
    } => resource !== undefined);
    for (const resource of resources) {
      await trx.executor.insertInto('golden_snapshot_cleanup').values({
        cleanup_id: randomUUID(), snapshot_id: snapshotId, build_id: build?.build_id ?? null,
        resource_type: resource.type, provider_resource_id: resource.id,
        provenance_key: resource.type === 'snapshot_image'
          ? `snapshot:${snapshotId}`
          : `build:${build!.build_id}:${resource.type}`,
        reason, status: 'queued', attempts: 0,
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


async function finalizeRetiringGoldenSnapshotWithoutImage(
  db: PlatformDB,
  snapshotId: string,
  now: string,
): Promise<boolean> {
  return db.transaction(async (trx) => {
    const identity = await trx.executor.selectFrom('golden_snapshots').select('base_generation')
      .where('snapshot_id', '=', snapshotId).executeTakeFirst();
    if (!identity) return false;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.base_generation}))`.execute(trx.executor);
    const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
      .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
    if (!snapshot || snapshot.state !== 'retiring' || snapshot.provider_image_id !== null) return false;
    const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
      .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
    if (build && (build.pending_operation !== null
      || build.provider_builder_id !== null
      || build.provider_validation_id !== null)) return false;
    const [unreleasedLease, pendingCleanup] = await Promise.all([
      trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
        .where('snapshot_id', '=', snapshotId).where('released_at', 'is', null).executeTakeFirst(),
      trx.executor.selectFrom('golden_snapshot_cleanup').select('cleanup_id')
        .where('snapshot_id', '=', snapshotId).where('completed_at', 'is', null).executeTakeFirst(),
    ]);
    if (unreleasedLease || pendingCleanup) return false;
    const deleted = await trx.executor.updateTable('golden_snapshots').set({
      state: 'deleted', deleted_at: now, updated_at: now, revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', snapshotId).where('state', '=', 'retiring')
      .where('revision', '=', snapshot.revision).returning('snapshot_id').executeTakeFirst();
    if (!deleted) return false;
    await appendGoldenSnapshotAuditEvent(trx, {
      snapshotId, buildId: build?.build_id, eventType: 'snapshot_deleted', actorType: 'worker',
      fromState: 'retiring', toState: 'deleted', reason: 'provider_image_absent', now,
    });
    return true;
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
  const [readyRows, disposableRows, retiringWithoutImageRows, channels] = await Promise.all([
    db.executor.selectFrom('golden_snapshots').select([
      'snapshot_id', 'bundle_version', 'compatibility_key', 'ready_at', 'test_mode',
    ]).where('state', '=', 'ready').orderBy('ready_at', 'desc').limit(100).execute(),
    db.executor.selectFrom('golden_snapshots').select('snapshot_id')
      .where('state', 'in', ['failed', 'quarantined'])
      .orderBy('updated_at').limit(100).execute(),
    db.executor.selectFrom('golden_snapshots').select('snapshot_id')
      .where('state', '=', 'retiring').where('provider_image_id', 'is', null)
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
  const productionReadyRows = readyRows.filter((row) => !row.test_mode);
  const targetCount = input.quotaPressure ? Math.max(0, input.retentionLimit - 1) : input.retentionLimit;
  const freshnessCutoff = input.freshnessMaxAgeMs === undefined
    ? undefined
    : new Date(new Date(input.now).getTime() - input.freshnessMaxAgeMs).toISOString();
  const freshnessExpired = new Set(productionReadyRows
    .filter((row) => freshnessCutoff !== undefined && row.ready_at !== null && row.ready_at <= freshnessCutoff)
    .map((row) => row.snapshot_id));
  const testModeCutoff = input.testModeTtlMs === undefined
    ? undefined
    : new Date(new Date(input.now).getTime() - input.testModeTtlMs).toISOString();
  const expiredTestMode = new Set(readyRows
    .filter((row) => row.test_mode && testModeCutoff !== undefined
      && row.ready_at !== null && row.ready_at <= testModeCutoff)
    .map((row) => row.snapshot_id));
  const retirementCount = Math.max(0, productionReadyRows.length - freshnessExpired.size - targetCount);

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
  for (const row of productionReadyRows) {
    if (freshnessExpired.has(row.snapshot_id)) continue;
    if (!newestByCompatibility.has(row.compatibility_key)) {
      newestByCompatibility.set(row.compatibility_key, row.snapshot_id);
      protectedSnapshots.add(row.snapshot_id);
    }
  }

  const expiredTestModeCandidates = [...readyRows].reverse().filter((row) =>
    expiredTestMode.has(row.snapshot_id) && !protectedSnapshots.has(row.snapshot_id));
  const freshnessCandidates = [...productionReadyRows].reverse().filter((row) =>
    freshnessExpired.has(row.snapshot_id) && !protectedSnapshots.has(row.snapshot_id));
  const candidates = [...productionReadyRows].reverse().filter((row) =>
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
  for (const testSnapshot of expiredTestModeCandidates) {
    try {
      const retired = await retireGoldenSnapshot(db, testSnapshot.snapshot_id, 'test_mode_expired', input.now, {
        rollbackVersionsPerChannel: input.rollbackVersionsPerChannel,
        freshnessMaxAgeMs: input.testModeTtlMs,
      });
      if (retired) retiredSnapshotIds.push(testSnapshot.snapshot_id);
    } catch (err: unknown) {
      console.error(
        `[golden-snapshot] test-mode retention failed snapshot=${testSnapshot.snapshot_id}: ${err instanceof Error ? err.name : typeof err}`,
      );
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
  const imageLessRetiringIds = new Set([
    ...retiringWithoutImageRows.map((row) => row.snapshot_id),
    ...retiredSnapshotIds,
  ]);
  for (const snapshotId of imageLessRetiringIds) {
    try {
      await finalizeRetiringGoldenSnapshotWithoutImage(db, snapshotId, input.now);
    } catch (err: unknown) {
      console.error(
        `[golden-snapshot] image-less retirement finalization failed snapshot=${snapshotId}: ${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }
  return {
    retiredSnapshotIds,
    blocked: retiredSnapshotIds.length
      < disposableRows.length + expiredTestModeCandidates.length + freshnessCandidates.length + retirementCount,
  };
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
