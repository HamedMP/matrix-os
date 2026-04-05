import { sql, type Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';

interface CreateInstallationInput {
  listing_id: string;
  version_id: string;
  user_id: string;
  org_id?: string;
  install_target: string;
  permissions_granted?: string[];
  data_location?: string;
  status?: string;
}

export async function createInstallation(
  db: Kysely<GalleryDatabase>,
  input: CreateInstallationInput,
) {
  return db.insertInto('app_installations')
    .values({
      listing_id: input.listing_id,
      version_id: input.version_id,
      user_id: input.user_id,
      org_id: input.org_id ?? null,
      install_target: input.install_target,
      permissions_granted: input.permissions_granted ?? [],
      data_location: input.data_location ?? null,
      status: input.status ?? 'active',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getByUserAndListing(
  db: Kysely<GalleryDatabase>,
  userId: string,
  listingId: string,
  orgId?: string,
) {
  let query = db.selectFrom('app_installations')
    .selectAll()
    .where('user_id', '=', userId)
    .where('listing_id', '=', listingId);

  if (orgId) {
    query = query.where('org_id', '=', orgId);
  } else {
    query = query.where('org_id', 'is', null);
  }

  const result = await query.executeTakeFirst();
  return result ?? null;
}

export async function listByUser(
  db: Kysely<GalleryDatabase>,
  userId: string,
  orgId?: string,
) {
  let query = db.selectFrom('app_installations')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('installed_at', 'desc');

  if (orgId) {
    query = query.where('org_id', '=', orgId);
  }

  return query.execute();
}

export async function deleteInstallation(
  db: Kysely<GalleryDatabase>,
  installationId: string,
) {
  return db.deleteFrom('app_installations')
    .where('id', '=', installationId)
    .execute();
}

export async function incrementInstallCount(
  db: Kysely<GalleryDatabase>,
  listingId: string,
) {
  return db.updateTable('app_listings')
    .set({
      installs_count: sql`installs_count + 1`,
      updated_at: new Date(),
    })
    .where('id', '=', listingId)
    .execute();
}

export async function decrementInstallCount(
  db: Kysely<GalleryDatabase>,
  listingId: string,
) {
  return db.updateTable('app_listings')
    .set({
      installs_count: sql`GREATEST(installs_count - 1, 0)`,
      updated_at: new Date(),
    })
    .where('id', '=', listingId)
    .execute();
}
