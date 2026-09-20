import { sql } from 'kysely';
import { z } from 'zod/v4';
import type {
  HostBundleChannelRecord,
  HostBundleReleaseRecord,
  HostBundleReleasesTable,
  HostBundleChannelsTable,
  NewHostBundleRelease,
  PlatformDB,
} from '../db.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): host bundle release and channel queries. */

const HostBundleTimestampSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export class HostBundleReleaseConflictError extends Error {
  constructor(version: string) {
    super(`Host bundle release already exists with different artifact fields: ${version}`);
    this.name = 'HostBundleReleaseConflictError';
  }
}

function mapHostBundleRelease(row: HostBundleReleasesTable): HostBundleReleaseRecord {
  return {
    version: row.version,
    channel: row.channel,
    gitCommit: row.git_commit,
    gitRef: row.git_ref,
    snapshotEligible: row.snapshot_eligible,
    buildTime: row.build_time,
    bundleKey: row.bundle_key,
    checksumKey: row.checksum_key,
    incrementalManifestKey: row.incremental_manifest_key,
    incrementalManifestSha256: row.incremental_manifest_sha256,
    sha256: row.sha256,
    size: Number(row.size),
    severity: row.severity,
    updateType: row.update_type,
    changelog: row.changelog,
    createdAt: row.created_at,
  };
}

function toHostBundleReleaseRow(record: NewHostBundleRelease): HostBundleReleasesTable {
  const now = new Date().toISOString();
  return {
    version: record.version,
    channel: record.channel ?? null,
    git_commit: record.gitCommit,
    git_ref: record.gitRef ?? null,
    snapshot_eligible: record.snapshotEligible ?? false,
    snapshot_eligibility_source: record.snapshotEligible === undefined ? 'legacy' : 'explicit',
    build_time: HostBundleTimestampSchema.parse(record.buildTime),
    bundle_key: record.bundleKey,
    checksum_key: record.checksumKey ?? null,
    incremental_manifest_key: record.incrementalManifestKey ?? null,
    incremental_manifest_sha256: record.incrementalManifestSha256 ?? null,
    sha256: record.sha256,
    size: record.size,
    severity: record.severity ?? 'normal',
    update_type: record.updateType ?? 'manual',
    changelog: record.changelog ?? null,
    created_at: record.createdAt === undefined
      ? now
      : HostBundleTimestampSchema.parse(record.createdAt),
  };
}

function mapHostBundleChannel(row: HostBundleChannelsTable): HostBundleChannelRecord {
  return {
    channel: row.channel,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export async function upsertHostBundleRelease(
  db: PlatformDB,
  record: NewHostBundleRelease,
): Promise<HostBundleReleaseRecord> {
  await db.ready;
  const row = toHostBundleReleaseRow(record);
  const saved = await db.executor
      .insertInto('host_bundle_releases')
      .values(row)
      .onConflict((oc) =>
        oc.column('version').doUpdateSet({
          severity: row.severity,
          update_type: row.update_type,
          changelog: row.changelog,
          incremental_manifest_key: row.incremental_manifest_key,
          incremental_manifest_sha256: row.incremental_manifest_sha256,
          snapshot_eligible: sql<boolean>`host_bundle_releases.snapshot_eligible OR ${row.snapshot_eligible}`,
          snapshot_eligibility_source: sql<string>`CASE
            WHEN ${row.snapshot_eligibility_source} = 'explicit' THEN 'explicit'
            ELSE host_bundle_releases.snapshot_eligibility_source
          END`,
        })
          .where(sql<boolean>`host_bundle_releases.bundle_key = ${row.bundle_key}`)
          .where(sql<boolean>`host_bundle_releases.git_commit = ${row.git_commit}`)
          .where(sql<boolean>`host_bundle_releases.git_ref IS NOT DISTINCT FROM ${row.git_ref}`)
          .where(sql<boolean>`host_bundle_releases.build_time::timestamptz = ${row.build_time}::timestamptz`)
          .where(sql<boolean>`host_bundle_releases.checksum_key IS NOT DISTINCT FROM ${row.checksum_key}`)
          .where(sql<boolean>`host_bundle_releases.incremental_manifest_key IS NOT DISTINCT FROM ${row.incremental_manifest_key}`)
          .where(sql<boolean>`host_bundle_releases.incremental_manifest_sha256 IS NOT DISTINCT FROM ${row.incremental_manifest_sha256}`)
          .where(sql<boolean>`host_bundle_releases.sha256 = ${row.sha256}`)
          .where(sql<boolean>`host_bundle_releases.size = ${row.size}`),
      )
      .returningAll()
      .executeTakeFirst();
  if (!saved) {
    throw new HostBundleReleaseConflictError(row.version);
  }
  return mapHostBundleRelease(saved);
}

export async function getHostBundleRelease(
  db: PlatformDB,
  version: string,
): Promise<HostBundleReleaseRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('host_bundle_releases')
    .selectAll()
    .where('version', '=', version)
    .executeTakeFirst();
  return row ? mapHostBundleRelease(row) : undefined;
}

export async function listHostBundleReleases(
  db: PlatformDB,
  limit = 50,
  channel?: string,
): Promise<HostBundleReleaseRecord[]> {
  await db.ready;
  if (channel) {
    const rows = await db.executor
      .selectFrom('host_bundle_release_channels')
      .innerJoin('host_bundle_releases', 'host_bundle_releases.version', 'host_bundle_release_channels.version')
      .selectAll('host_bundle_releases')
      .where('host_bundle_release_channels.channel', '=', channel)
      .orderBy('host_bundle_releases.created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(mapHostBundleRelease);
  }
  const rows = await db.executor
    .selectFrom('host_bundle_releases')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(mapHostBundleRelease);
}

export async function promoteHostBundleChannel(
  db: PlatformDB,
  channel: string,
  version: string,
  updatedAt = new Date().toISOString(),
): Promise<HostBundleChannelRecord> {
  await db.ready;
  return db.transaction((trx) => promoteHostBundleChannelInTransaction(trx, channel, version, updatedAt));
}

export async function promoteHostBundleChannelInTransaction(
  db: PlatformDB,
  channel: string,
  version: string,
  updatedAt: string,
): Promise<HostBundleChannelRecord> {
    const release = await db.executor
      .selectFrom('host_bundle_releases')
      .selectAll()
      .where('version', '=', version)
      .forUpdate()
      .executeTakeFirst();
    if (!release) {
      throw new Error('Cannot promote unknown host bundle release');
    }
    const row = await db.executor
      .insertInto('host_bundle_channels')
      .values({ channel, version, updated_at: updatedAt })
      .onConflict((oc) =>
        oc.column('channel').doUpdateSet({
          version,
          updated_at: updatedAt,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.executor
      .insertInto('host_bundle_release_channels')
      .values({ channel, version, promoted_at: updatedAt })
      .onConflict((oc) => oc.columns(['channel', 'version']).doUpdateSet({
        promoted_at: updatedAt,
      }))
      .executeTakeFirst();
    return mapHostBundleChannel(row);
}

export async function registerHostBundleRelease(
  db: PlatformDB,
  record: NewHostBundleRelease,
  channel?: string,
): Promise<{ release: HostBundleReleaseRecord; channel?: HostBundleChannelRecord }> {
  await db.ready;
  return db.transaction(async (trx) => {
    const release = await upsertHostBundleRelease(trx, record);
    if (!channel) return { release };
    return {
      release,
      channel: await promoteHostBundleChannelInTransaction(
        trx, channel, release.version, new Date().toISOString(),
      ),
    };
  });
}

export async function getHostBundleChannel(
  db: PlatformDB,
  channel: string,
): Promise<HostBundleChannelRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('host_bundle_channels')
    .selectAll()
    .where('channel', '=', channel)
    .executeTakeFirst();
  return row ? mapHostBundleChannel(row) : undefined;
}

export async function getHostBundleReleaseByChannel(
  db: PlatformDB,
  channel: string,
): Promise<HostBundleReleaseRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('host_bundle_channels')
    .innerJoin('host_bundle_releases', 'host_bundle_releases.version', 'host_bundle_channels.version')
    .selectAll('host_bundle_releases')
    .where('host_bundle_channels.channel', '=', channel)
    .executeTakeFirst();
  return row ? mapHostBundleRelease(row) : undefined;
}
