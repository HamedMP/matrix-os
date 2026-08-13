import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import { enqueueGoldenSnapshotBuild } from './golden-snapshot-repository.js';
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

const MissingBuildReconciliationInputSchema = z.object({
  compatibility: GoldenSnapshotCompatibilitySchema,
  now: IsoDateSchema,
  limit: z.number().int().min(1).max(100),
  freshnessMaxAgeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000),
}).strict();

export async function reconcileMissingGoldenSnapshotBuilds(
  db: PlatformDB,
  rawInput: z.input<typeof MissingBuildReconciliationInputSchema>,
): Promise<{ enqueued: number }> {
  const input = MissingBuildReconciliationInputSchema.parse(rawInput);
  const key = compatibilityKey(input.compatibility);
  const freshnessCutoff = new Date(
    new Date(input.now).getTime() - input.freshnessMaxAgeMs,
  ).toISOString();
  await db.ready;
  // During the first rollout, an old platform revision can accept and promote
  // a release while stripping the new eligibility field. Only legacy rows are
  // repaired; an explicit false remains an authoritative opt-out.
  await db.executor.updateTable('host_bundle_releases').set({ snapshot_eligible: true })
    .where('snapshot_eligible', '=', false)
    .where('snapshot_eligibility_source', '=', 'legacy')
    .where((eb) => eb.exists(
      eb.selectFrom('host_bundle_channels').select('channel')
        .whereRef('host_bundle_channels.version', '=', 'host_bundle_releases.version')
        .where('host_bundle_channels.channel', 'in', ['dev', 'canary', 'beta', 'stable']),
    )).execute();
  const missing = await db.executor.selectFrom('host_bundle_releases')
    .select('version')
    .where('snapshot_eligible', '=', true)
    .where((eb) => eb.not(eb.exists(
      eb.selectFrom('golden_snapshots').select('snapshot_id')
        .whereRef('golden_snapshots.bundle_sha256', '=', 'host_bundle_releases.sha256')
        .where('golden_snapshots.compatibility_key', '=', key)
        .where('golden_snapshots.test_mode', '=', false)
        .where('golden_snapshots.state', '=', 'ready')
        .where('golden_snapshots.ready_at', '>', freshnessCutoff),
    )))
    .where((eb) => eb.not(eb.exists(
      eb.selectFrom('golden_snapshots').select('snapshot_id')
        .whereRef('golden_snapshots.bundle_sha256', '=', 'host_bundle_releases.sha256')
        .where('golden_snapshots.compatibility_key', '=', key)
        .where('golden_snapshots.test_mode', '=', false)
        .where('golden_snapshots.state', 'in', [
          'candidate', 'building', 'sanitizing', 'validating', 'failed', 'quarantined',
        ]),
    )))
    .orderBy('build_time', 'desc').limit(input.limit).execute();
  let enqueued = 0;
  for (const release of missing) {
    try {
      const result = await enqueueGoldenSnapshotBuild(db, {
        bundleVersion: release.version,
        compatibility: input.compatibility,
        replaceReady: true,
        snapshotId: randomUUID(),
        buildId: randomUUID(),
        now: input.now,
      });
      if (!result.reused) enqueued += 1;
    } catch (err: unknown) {
      console.error(
        `[golden-snapshot] missing-build enqueue failed release=${release.version}: ${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }
  return { enqueued };
}
