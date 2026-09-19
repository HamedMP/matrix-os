/**
 * Golden snapshot lease persistence.
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

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  IsoDateSchema,
  SelectInputSchema,
  Sha256Schema,
  UuidSchema,
} from './schemas.js';
import {
  appendGoldenSnapshotAuditEvent,
} from './lifecycle.js';

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
  // Expired-but-unreleased leases still protect ambiguous provider clones.
  const remainingUnreleasedLease = await trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
    .where('snapshot_id', '=', snapshot.snapshot_id).where('released_at', 'is', null)
    .executeTakeFirst();
  if (remainingUnreleasedLease) return;
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
      const existingTarget = sameTarget
        ? await trx.executor.selectFrom('host_bundle_releases').select('sha256')
          .where('version', '=', input.targetBundleVersion).executeTakeFirst()
        : undefined;
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
        && existingTarget !== undefined
        && existingSnapshot.bundleSha256 === existingTarget.sha256.toLowerCase()
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
      // Production recovery selection happens before the machine becomes
      // recovering. Keep this repository-level guard for duplicate/stale
      // callers so an expired lease cannot be retargeted during live recovery.
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
    const target = await trx.executor.selectFrom('host_bundle_releases').select('sha256')
      .where('version', '=', input.targetBundleVersion).executeTakeFirstOrThrow();
    const targetSha256 = Sha256Schema.parse(target.sha256.toLowerCase());
    const candidates = await trx.executor.selectFrom('golden_snapshots')
      .selectAll()
      .where('golden_snapshots.state', '=', 'ready').where('golden_snapshots.compatibility_key', '=', key)
      .where('golden_snapshots.ready_at', '>', freshnessCutoff)
      .where('golden_snapshots.test_mode', '=', false)
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom('golden_snapshot_revoked_base_generations').select('base_generation')
          .whereRef('golden_snapshot_revoked_base_generations.base_generation', '=', 'golden_snapshots.base_generation'),
      )))
      .where('golden_snapshots.minimum_disk_gb', '<=', input.serverDiskGb)
      .where('golden_snapshots.bundle_sha256', '=', targetSha256)
      .where((eb) => eb.or([
        eb('golden_snapshots.image_disk_gb', 'is', null),
        eb('golden_snapshots.image_disk_gb', '<=', input.serverDiskGb),
      ]))
      .orderBy('golden_snapshots.ready_at', 'desc').limit(100).execute();
    const chosen = chooseGoldenSnapshot({
      targetBundleSha256: targetSha256,
      compatibilityKey: key,
      serverDiskGb: input.serverDiskGb,
      activationAbi: input.compatibility.activationAbi,
    }, candidates.map((row) => ({
      snapshotId: row.snapshot_id,
      bundleVersion: row.bundle_version,
      bundleSha256: row.bundle_sha256,
      compatibilityKey: row.compatibility_key,
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


async function releaseGoldenSnapshotLeaseTx(
  trx: PlatformDB,
  leaseId: string,
  now: string,
): Promise<boolean> {
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
}


export async function releaseGoldenSnapshotLeaseInTransaction(
  trx: PlatformDB,
  rawLeaseId: string,
  rawNow: string,
): Promise<boolean> {
  const leaseId = UuidSchema.parse(rawLeaseId);
  const now = IsoDateSchema.parse(rawNow);
  await trx.ready;
  return releaseGoldenSnapshotLeaseTx(trx, leaseId, now);
}


export async function releaseGoldenSnapshotLease(db: PlatformDB, rawLeaseId: string, rawNow: string): Promise<boolean> {
  const leaseId = UuidSchema.parse(rawLeaseId);
  const now = IsoDateSchema.parse(rawNow);
  await db.ready;
  return db.transaction((trx) => releaseGoldenSnapshotLeaseTx(trx, leaseId, now));
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
    // Expiry alone cannot release protection for a possibly surviving clone.
    // The recovery reconciler first confirms exact replacement deletion, then
    // restores the old machine and releases this lease in the same transaction.
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
