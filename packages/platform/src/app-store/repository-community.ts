import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { getStoreListing, getStoreVersion } from './repository-listings.js';
import { AppStoreError } from './errors.js';
export function createCommunityRepository(db: PlatformDB, now: () => string) {
  async function install(owner: string, slug: string, versionId: string) {
    return db.transaction(async trx => {
      const listing = await getStoreListing(trx, slug, true); const version = await getStoreVersion(trx, versionId);
      const old = await trx.executor.selectFrom('app_store_installs').selectAll().where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).forUpdate().executeTakeFirst();
      if (listing.status === 'suspended' || version.listing_id !== listing.id || !['published', 'superseded'].includes(version.status)
        || (!(listing.status === 'live' && listing.current_version_id === versionId) && old?.version_id !== versionId)) throw new AppStoreError('forbidden');
      const time = now();
      await trx.executor.insertInto('app_store_installs').values({ listing_id: listing.id, clerk_user_id: owner, version_id: versionId,
        first_installed_at: time, last_installed_at: time, uninstalled_at: null }).onConflict(oc => oc.columns(['listing_id', 'clerk_user_id']).doUpdateSet({ version_id: versionId, last_installed_at: time, uninstalled_at: null })).execute();
      const unique = old ? 0 : 1; const active = old && old.uninstalled_at === null ? 0 : 1;
      await trx.executor.updateTable('app_store_listings').set({ install_count: sql`install_count + ${unique}`, active_install_count: sql`active_install_count + ${active}` }).where('id', '=', listing.id).execute();
      return { installed: true, versionId, installCount: listing.install_count + unique, activeInstallCount: listing.active_install_count + active };
    });
  }
  async function uninstall(owner: string, slug: string) {
    return db.transaction(async trx => {
      const listing = await getStoreListing(trx, slug, true);
      const old = await trx.executor.selectFrom('app_store_installs').selectAll().where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).forUpdate().executeTakeFirst();
      const active = old?.uninstalled_at === null ? 1 : 0;
      if (active) {
        await trx.executor.updateTable('app_store_installs').set({ uninstalled_at: now() }).where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).where('uninstalled_at', 'is', null).execute();
        await trx.executor.updateTable('app_store_listings').set({ active_install_count: sql`active_install_count - 1` }).where('id', '=', listing.id).execute();
      }
      return { installed: false, versionId: old?.version_id ?? null, installCount: listing.install_count, activeInstallCount: listing.active_install_count - active };
    });
  }
  async function rate(owner: string, slug: string, stars: number | null) {
    return db.transaction(async trx => {
      const listing = await getStoreListing(trx, slug, true);
      const install = await trx.executor.selectFrom('app_store_installs').select('listing_id').where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).executeTakeFirst();
      if (!install || listing.publisher_clerk_user_id === owner) throw new AppStoreError('forbidden');
      if (stars !== null && (!Number.isInteger(stars) || stars < 1 || stars > 5)) throw new AppStoreError('invalid');
      if (stars !== null && listing.status !== 'live') throw new AppStoreError('forbidden');
      const old = await trx.executor.selectFrom('app_store_ratings').selectAll().where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).forUpdate().executeTakeFirst();
      if (stars === null) await trx.executor.deleteFrom('app_store_ratings').where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).execute();
      else await trx.executor.insertInto('app_store_ratings').values({ listing_id: listing.id, clerk_user_id: owner, stars, created_at: now(), updated_at: now() })
        .onConflict(oc => oc.columns(['listing_id', 'clerk_user_id']).doUpdateSet({ stars, updated_at: now() })).execute();
      const delta = (stars ?? 0) - (old?.stars ?? 0); const countDelta = stars === null ? old ? -1 : 0 : old ? 0 : 1;
      await trx.executor.updateTable('app_store_listings').set({ rating_sum: sql`rating_sum + ${delta}`, rating_count: sql`rating_count + ${countDelta}` }).where('id', '=', listing.id).execute();
      const count = listing.rating_count + countDelta;
      return { myRating: stars, ratingAverage: count ? (listing.rating_sum + delta) / count : null, ratingCount: count };
    });
  }
  return { install, uninstall, rate };
}
