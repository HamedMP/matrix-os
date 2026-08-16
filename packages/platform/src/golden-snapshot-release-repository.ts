import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import {
  getHostBundleRelease,
  promoteHostBundleChannelInTransaction,
  upsertHostBundleRelease,
  type HostBundleChannelRecord,
  type HostBundleReleaseRecord,
  type NewHostBundleRelease,
  type PlatformDB,
} from './db.js';
import {
  appendGoldenSnapshotAuditEvent,
  enqueueGoldenSnapshotBuildInTransaction,
} from './golden-snapshot-repository.js';
import {
  compatibilityKey,
  GoldenSnapshotCompatibilitySchema,
  GoldenSnapshotStateSchema,
  type GoldenSnapshotCompatibility,
  type GoldenSnapshotState,
} from './golden-snapshot-schema.js';

const IsoDateSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
// Status is projected onto every accepted host-bundle release, including
// legacy/non-eligible names that can never identify a snapshot build.
const HostBundleStatusVersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const CoarseStatusFreshnessSchema = z.object({
  now: IsoDateSchema,
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000),
}).strict();

const StableSnapshotRegistrationSchema = z.object({
  compatibility: GoldenSnapshotCompatibilitySchema.optional(),
  snapshotId: z.uuid().optional(),
  buildId: z.uuid().optional(),
  now: IsoDateSchema,
}).strict();

const StableSnapshotPromotionSchema = StableSnapshotRegistrationSchema.extend({
  snapshotEligible: z.boolean().optional(),
}).strict();

const SUPERSEDED_STABLE_RELEASE = 'superseded_stable_release';

function requireStableSnapshotBuildInput(
  input: z.output<typeof StableSnapshotRegistrationSchema>,
): {
  compatibility: z.output<typeof GoldenSnapshotCompatibilitySchema>;
  snapshotId: string;
  buildId: string;
} {
  if (!input.compatibility || !input.snapshotId || !input.buildId) {
    throw new Error('Eligible stable promotion requires golden snapshot configuration');
  }
  return {
    compatibility: input.compatibility,
    snapshotId: input.snapshotId,
    buildId: input.buildId,
  };
}

async function supersedeUnfinishedStableSnapshotBuilds(
  trx: PlatformDB,
  currentBundleSha256: string,
  preserveCurrentBundleDigest: boolean,
  now: string,
): Promise<void> {
  let query = trx.executor.selectFrom('golden_snapshots')
    .innerJoin('golden_snapshot_builds', 'golden_snapshot_builds.snapshot_id', 'golden_snapshots.snapshot_id')
    .select([
      'golden_snapshots.snapshot_id', 'golden_snapshots.state', 'golden_snapshots.revision',
      'golden_snapshots.provider_image_id', 'golden_snapshot_builds.build_id',
      'golden_snapshot_builds.provider_builder_id', 'golden_snapshot_builds.provider_validation_id',
    ])
    .where('golden_snapshots.test_mode', '=', false)
    .where('golden_snapshots.state', 'in', ['candidate', 'building', 'sanitizing', 'validating'])
    .where('golden_snapshot_builds.status', 'in', ['queued', 'running']);
  if (preserveCurrentBundleDigest) {
    query = query.where('golden_snapshots.bundle_sha256', '!=', currentBundleSha256);
  }
  const rows = await query.orderBy('golden_snapshots.snapshot_id').forUpdate().execute();
  for (const row of rows) {
    const unreleasedLease = await trx.executor.selectFrom('golden_snapshot_leases').select('lease_id')
      .where('snapshot_id', '=', row.snapshot_id).where('released_at', 'is', null)
      .executeTakeFirst();
    await trx.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', failure_code: SUPERSEDED_STABLE_RELEASE,
      quarantined_at: now, updated_at: now, revision: sql<number>`revision + 1`,
    }).where('snapshot_id', '=', row.snapshot_id).where('revision', '=', row.revision)
      .executeTakeFirstOrThrow();
    await trx.executor.updateTable('golden_snapshot_builds').set({
      phase: 'failed', status: 'failed', last_error_code: SUPERSEDED_STABLE_RELEASE,
      lease_expires_at: null, callback_phase: null, callback_token_hash: null,
      callback_expires_at: null, completed_at: now, updated_at: now,
    }).where('build_id', '=', row.build_id).where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow();
    await trx.executor.updateTable('golden_snapshot_create_intents').set({
      state: 'denied', updated_at: now,
    }).where('snapshot_id', '=', row.snapshot_id).where('state', 'in', ['pending', 'accepted'])
      .where('completed_at', 'is', null).execute();
    await appendGoldenSnapshotAuditEvent(trx, {
      snapshotId: row.snapshot_id, buildId: row.build_id,
      eventType: 'snapshot_revoked', actorType: 'release',
      fromState: row.state, toState: 'quarantined', reason: SUPERSEDED_STABLE_RELEASE, now,
    });
    const resources = [
      row.provider_builder_id === null ? undefined : {
        type: 'builder_server' as const, id: row.provider_builder_id,
      },
      row.provider_validation_id === null ? undefined : {
        type: 'validation_server' as const, id: row.provider_validation_id,
      },
      row.provider_image_id === null || unreleasedLease ? undefined : {
        type: 'snapshot_image' as const, id: row.provider_image_id,
      },
    ].filter((resource): resource is {
      type: 'builder_server' | 'validation_server' | 'snapshot_image'; id: number;
    } => resource !== undefined);
    for (const resource of resources) {
      await trx.executor.insertInto('golden_snapshot_cleanup').values({
        cleanup_id: randomUUID(), snapshot_id: row.snapshot_id, build_id: row.build_id,
        resource_type: resource.type, provider_resource_id: resource.id,
        provenance_key: `supersede:${row.snapshot_id}:${resource.type}`,
        reason: SUPERSEDED_STABLE_RELEASE, status: 'queued', attempts: 0,
        next_attempt_at: now, lease_expires_at: null, last_error_code: null,
        created_at: now, completed_at: null,
      }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
        .where('completed_at', 'is', null).doNothing()).execute();
    }
  }
}

export async function registerHostBundleReleaseWithStableSnapshot(
  db: PlatformDB,
  record: NewHostBundleRelease,
  channel: string | undefined,
  rawInput: z.input<typeof StableSnapshotRegistrationSchema>,
): Promise<{ release: HostBundleReleaseRecord; channel?: HostBundleChannelRecord }> {
  const input = StableSnapshotRegistrationSchema.parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('golden_snapshot_stable_promotion'))`
      .execute(trx.executor);
    const snapshotEligible = record.snapshotEligible ?? channel === 'stable';
    let release = await upsertHostBundleRelease(trx, { ...record, snapshotEligible });
    if (!channel) return { release };
    if (channel === 'stable') {
      await trx.executor.updateTable('host_bundle_releases').set({
        snapshot_eligible: snapshotEligible,
        snapshot_eligibility_source: 'explicit',
      }).where('version', '=', release.version).executeTakeFirstOrThrow();
      const registered = await getHostBundleRelease(trx, release.version);
      if (!registered) throw new Error('Cannot load registered host bundle release');
      release = registered;
    }
    const promoted = await promoteHostBundleChannelInTransaction(
      trx, channel, release.version, input.now,
    );
    if (channel === 'stable') {
      await supersedeUnfinishedStableSnapshotBuilds(
        trx, release.sha256, release.snapshotEligible, input.now,
      );
    }
    if (channel === 'stable' && release.snapshotEligible) {
      const buildInput = requireStableSnapshotBuildInput(input);
      await enqueueGoldenSnapshotBuildInTransaction(trx, {
        bundleVersion: release.version,
        ...buildInput,
        now: input.now,
      });
    }
    return { release, channel: promoted };
  });
}

export async function promoteHostBundleChannelWithStableSnapshot(
  db: PlatformDB,
  channel: string,
  version: string,
  rawInput: z.input<typeof StableSnapshotPromotionSchema>,
): Promise<{ release: HostBundleReleaseRecord; channel: HostBundleChannelRecord }> {
  const input = StableSnapshotPromotionSchema.parse(rawInput);
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('golden_snapshot_stable_promotion'))`
      .execute(trx.executor);
    const existing = await getHostBundleRelease(trx, version);
    if (!existing) throw new Error('Cannot promote unknown host bundle release');
    if (channel === 'stable') {
      await trx.executor.updateTable('host_bundle_releases').set({
        snapshot_eligible: input.snapshotEligible ?? true,
        snapshot_eligibility_source: 'explicit',
      }).where('version', '=', version).executeTakeFirstOrThrow();
    }
    const release = await getHostBundleRelease(trx, version);
    if (!release) throw new Error('Cannot promote unknown host bundle release');
    const promoted = await promoteHostBundleChannelInTransaction(trx, channel, version, input.now);
    if (channel === 'stable') {
      await supersedeUnfinishedStableSnapshotBuilds(
        trx, release.sha256, release.snapshotEligible, input.now,
      );
    }
    if (channel === 'stable' && release.snapshotEligible) {
      const buildInput = requireStableSnapshotBuildInput(input);
      await enqueueGoldenSnapshotBuildInTransaction(trx, {
        bundleVersion: release.version,
        ...buildInput,
        now: input.now,
      });
    }
    return { release, channel: promoted };
  });
}

export type GoldenSnapshotCoarseStatus =
  | 'not_requested'
  | 'requested'
  | 'building'
  | 'ready'
  | 'failed'
  | 'unavailable';

function coarseStatus(states: GoldenSnapshotState[]): GoldenSnapshotCoarseStatus {
  if (states.includes('ready')) return 'ready';
  if (states.some((state) => state === 'building' || state === 'sanitizing' || state === 'validating')) {
    return 'building';
  }
  if (states.includes('candidate')) return 'requested';
  if (states.some((state) => state === 'failed' || state === 'quarantined')) return 'failed';
  if (states.some((state) => state === 'retiring' || state === 'deleted')) return 'unavailable';
  return 'not_requested';
}

export async function getGoldenSnapshotCoarseStatus(
  db: PlatformDB,
  rawBundleVersion: string,
  rawCompatibility?: GoldenSnapshotCompatibility,
  rawFreshness?: z.input<typeof CoarseStatusFreshnessSchema>,
): Promise<GoldenSnapshotCoarseStatus> {
  const bundleVersion = HostBundleStatusVersionSchema.parse(rawBundleVersion);
  return (await getGoldenSnapshotCoarseStatuses(db, [bundleVersion], rawCompatibility, rawFreshness))
    .get(bundleVersion) ?? 'not_requested';
}

export async function getGoldenSnapshotCoarseStatuses(
  db: PlatformDB,
  rawBundleVersions: string[],
  rawCompatibility?: GoldenSnapshotCompatibility,
  rawFreshness?: z.input<typeof CoarseStatusFreshnessSchema>,
): Promise<Map<string, GoldenSnapshotCoarseStatus>> {
  const bundleVersions = z.array(HostBundleStatusVersionSchema).max(100)
    .transform((versions) => [...new Set(versions)]).parse(rawBundleVersions);
  const activeCompatibilityKey = rawCompatibility === undefined
    ? undefined
    : compatibilityKey(GoldenSnapshotCompatibilitySchema.parse(rawCompatibility));
  const freshness = rawFreshness === undefined
    ? undefined
    : CoarseStatusFreshnessSchema.parse(rawFreshness);
  const freshnessCutoff = freshness === undefined
    ? undefined
    : new Date(new Date(freshness.now).getTime() - freshness.freshnessMaxAgeMs).toISOString();
  await db.ready;
  const result = new Map<string, GoldenSnapshotCoarseStatus>(
    bundleVersions.map((version) => [version, 'not_requested']),
  );
  if (bundleVersions.length === 0) return result;
  let query = db.executor.selectFrom('host_bundle_releases')
    .innerJoin('golden_snapshots', 'golden_snapshots.bundle_sha256', 'host_bundle_releases.sha256')
    .select(['host_bundle_releases.version as bundle_version', 'golden_snapshots.state'])
    .where('host_bundle_releases.version', 'in', bundleVersions)
    .where('golden_snapshots.test_mode', '=', false);
  if (activeCompatibilityKey !== undefined) {
    query = query.where('golden_snapshots.compatibility_key', '=', activeCompatibilityKey);
  }
  if (freshnessCutoff !== undefined) {
    query = query.where((eb) => eb.or([
      eb('golden_snapshots.state', '!=', 'ready'),
      eb('golden_snapshots.ready_at', '>', freshnessCutoff),
    ]));
  }
  const rows = await query.groupBy(['host_bundle_releases.version', 'golden_snapshots.state']).execute();
  const grouped = new Map<string, GoldenSnapshotState[]>();
  for (const row of rows) {
    const states = grouped.get(row.bundle_version) ?? [];
    states.push(GoldenSnapshotStateSchema.parse(row.state));
    grouped.set(row.bundle_version, states);
  }
  for (const [version, states] of grouped) result.set(version, coarseStatus(states));
  return result;
}
