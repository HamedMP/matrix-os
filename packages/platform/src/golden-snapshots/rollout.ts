/**
 * Golden snapshot rollout-control and create-intent persistence.
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
  IsoDateSchema,
  Sha256Schema,
  UuidSchema,
} from './schemas.js';

export async function initializeGoldenSnapshotRolloutControl(
  db: PlatformDB,
  rawInput: {
    compatibility: GoldenSnapshotCompatibility;
    enabled: boolean;
    percentage: number;
    now: string;
  },
): Promise<GoldenSnapshotRolloutControlRecord> {
  const input = z.object({
    compatibility: GoldenSnapshotCompatibilitySchema,
    enabled: z.boolean(),
    percentage: z.number().int().min(0).max(100),
    now: IsoDateSchema,
  }).parse(rawInput);
  const key = compatibilityKey(input.compatibility);
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(trx.executor);
    await trx.executor.insertInto('golden_snapshot_rollout_controls').values({
      compatibility_key: key,
      enabled: input.enabled,
      percentage: input.percentage,
      generation: 1,
      updated_at: input.now,
    }).onConflict((oc) => oc.column('compatibility_key').doNothing()).execute();
    const row = await trx.executor.selectFrom('golden_snapshot_rollout_controls').selectAll()
      .where('compatibility_key', '=', key).executeTakeFirstOrThrow();
    return mapRolloutControl(row);
  });
}


export async function getGoldenSnapshotRolloutControl(
  db: PlatformDB,
  rawCompatibilityKey: string,
): Promise<GoldenSnapshotRolloutControlRecord | undefined> {
  const key = Sha256Schema.parse(rawCompatibilityKey);
  await db.ready;
  const row = await db.executor.selectFrom('golden_snapshot_rollout_controls').selectAll()
    .where('compatibility_key', '=', key).executeTakeFirst();
  return row ? mapRolloutControl(row) : undefined;
}


export async function updateGoldenSnapshotRolloutControl(
  db: PlatformDB,
  rawInput: {
    compatibilityKey: string;
    enabled: boolean;
    percentage: number;
    now: string;
  },
): Promise<GoldenSnapshotRolloutControlRecord> {
  const input = z.object({
    compatibilityKey: Sha256Schema,
    enabled: z.boolean(),
    percentage: z.number().int().min(0).max(100),
    now: IsoDateSchema,
  }).parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.compatibilityKey}))`
      .execute(trx.executor);
    const current = await trx.executor.selectFrom('golden_snapshot_rollout_controls').selectAll()
      .where('compatibility_key', '=', input.compatibilityKey).forUpdate().executeTakeFirst();
    const row = current
      ? await trx.executor.updateTable('golden_snapshot_rollout_controls').set({
          enabled: input.enabled,
          percentage: input.percentage,
          generation: sql<number>`generation + 1`,
          updated_at: input.now,
        }).where('compatibility_key', '=', input.compatibilityKey).returningAll().executeTakeFirstOrThrow()
      : await trx.executor.insertInto('golden_snapshot_rollout_controls').values({
          compatibility_key: input.compatibilityKey,
          enabled: input.enabled,
          percentage: input.percentage,
          generation: 1,
          updated_at: input.now,
        }).returningAll().executeTakeFirstOrThrow();
    await trx.executor.updateTable('golden_snapshot_create_intents').set({
      state: 'denied', updated_at: input.now,
    }).where('snapshot_id', 'in', trx.executor.selectFrom('golden_snapshots')
      .select('snapshot_id').where('compatibility_key', '=', input.compatibilityKey))
      .where('state', 'in', ['pending', 'accepted'])
      .where('completed_at', 'is', null).execute();
    return mapRolloutControl(row);
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
      .select(['snapshot_id', 'base_generation', 'compatibility_key'])
      .where('snapshot_id', '=', input.snapshotId)
      .executeTakeFirst();
    if (!identity) return undefined;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.base_generation}))`.execute(trx.executor);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${identity.compatibility_key}))`.execute(trx.executor);
    const rollout = await trx.executor.selectFrom('golden_snapshot_rollout_controls').selectAll()
      .where('compatibility_key', '=', identity.compatibility_key).forUpdate().executeTakeFirst();
    if (!rollout || !rollout.enabled || Number(rollout.generation) !== input.rolloutGeneration) {
      return undefined;
    }
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
    const linkedJob = await trx.executor.updateTable('provisioning_jobs').set({
      snapshot_create_intent_id: row.intent_id,
      updated_at: input.now,
    }).where('snapshot_lease_id', '=', input.leaseId)
      .where((eb) => eb.or([
        eb('snapshot_create_intent_id', 'is', null),
        eb('snapshot_create_intent_id', '=', row.intent_id),
      ]))
      .returning('job_id').executeTakeFirst();
    if (!linkedJob) {
      const conflictingJob = await trx.executor.selectFrom('provisioning_jobs')
        .select(['job_id', 'snapshot_create_intent_id'])
        .where('snapshot_lease_id', '=', input.leaseId).executeTakeFirst();
      if (conflictingJob && conflictingJob.snapshot_create_intent_id !== row.intent_id) {
        throw new Error('Golden snapshot provisioning intent linkage conflict');
      }
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
    if (providerActionId !== null && current.provider_create_action_id !== null
      && Number(current.provider_create_action_id) !== providerActionId) {
      throw new Error('Golden snapshot create intent provider action conflict');
    }
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
