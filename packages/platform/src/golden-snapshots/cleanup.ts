/**
 * Golden snapshot cleanup and retention persistence.
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

import { z } from 'zod/v4';
import {
  IsoDateSchema,
  UuidSchema,
} from './schemas.js';
import {
  appendGoldenSnapshotAuditEvent,
} from './lifecycle.js';

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
