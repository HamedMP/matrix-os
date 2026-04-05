import type { Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';

export interface InstallationWithUpdateStatus {
  installationId: string;
  listingId: string;
  listingSlug: string;
  listingName: string;
  iconUrl: string | null;
  installedVersion: string;
  currentVersion: string;
  hasUpdate: boolean;
  installTarget: string;
  status: string;
  installedAt: Date;
}

export async function getInstallationsWithUpdateStatus(
  db: Kysely<GalleryDatabase>,
  userId: string
): Promise<InstallationWithUpdateStatus[]> {
  const rows = await db
    .selectFrom('app_installations as i')
    .innerJoin('app_listings as l', 'l.id', 'i.listing_id')
    .innerJoin('app_versions as iv', 'iv.id', 'i.version_id')
    .leftJoin('app_versions as cv', 'cv.id', 'l.current_version_id')
    .where('i.user_id', '=', userId)
    .select([
      'i.id as installationId',
      'l.id as listingId',
      'l.slug as listingSlug',
      'l.name as listingName',
      'l.icon_url as iconUrl',
      'iv.version as installedVersion',
      'cv.version as currentVersion',
      'i.version_id as installedVersionId',
      'l.current_version_id as currentVersionId',
      'i.install_target as installTarget',
      'i.status',
      'i.installed_at as installedAt',
    ])
    .execute();

  return rows.map((row) => ({
    installationId: row.installationId,
    listingId: row.listingId,
    listingSlug: row.listingSlug,
    listingName: row.listingName,
    iconUrl: row.iconUrl,
    installedVersion: row.installedVersion,
    currentVersion: row.currentVersion ?? row.installedVersion,
    hasUpdate:
      row.currentVersionId !== null &&
      row.installedVersionId !== row.currentVersionId,
    installTarget: row.installTarget,
    status: row.status,
    installedAt: row.installedAt,
  }));
}

export async function markInstallationUpdated(
  db: Kysely<GalleryDatabase>,
  installationId: string,
  newVersionId: string
): Promise<void> {
  await db
    .updateTable('app_installations')
    .set({
      version_id: newVersionId,
      status: 'active',
      updated_at: new Date(),
    })
    .where('id', '=', installationId)
    .execute();
}

export async function getPreviousVersion(
  db: Kysely<GalleryDatabase>,
  listingId: string,
  currentVersionId: string
): Promise<{ id: string; version: string; changelog: string | null } | null> {
  const currentVersion = await db
    .selectFrom('app_versions')
    .select(['created_at'])
    .where('id', '=', currentVersionId)
    .executeTakeFirst();

  if (!currentVersion) return null;

  const previous = await db
    .selectFrom('app_versions')
    .select(['id', 'version', 'changelog'])
    .where('listing_id', '=', listingId)
    .where('created_at', '<', currentVersion.created_at)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return previous ?? null;
}
