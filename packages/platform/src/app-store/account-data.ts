import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
/** Called within the account erasure transaction, after storage cleanup. Public
 * signed manifests remain immutable; private reports and owner identifiers do not. */
export async function eraseAppStoreOwnerData(trx: PlatformDB, owner: string, anonymous: string): Promise<void> {
  const present = await sql<{ present: boolean }>`SELECT to_regclass('app_store_listings') IS NOT NULL AS present`.execute(trx.executor);
  if (!present.rows[0]?.present) return;
  let cursor = '';
  for (;;) {
    const affected = await trx.executor.selectFrom('app_store_listings').selectAll().where('id', '>', cursor)
      .where(eb => eb.or([eb('publisher_clerk_user_id', '=', owner), eb('id', 'in',
        eb.selectFrom('app_store_installs').select('listing_id').where('clerk_user_id', '=', owner)), eb('id', 'in',
        eb.selectFrom('app_store_ratings').select('listing_id').where('clerk_user_id', '=', owner))]))
      .orderBy('id').limit(100).forUpdate().execute();
    for (const listing of affected) {
      const install = await trx.executor.selectFrom('app_store_installs').select('uninstalled_at').where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).executeTakeFirst();
      const rating = await trx.executor.selectFrom('app_store_ratings').select('stars').where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).executeTakeFirst();
      await trx.executor.updateTable('app_store_listings').set({
        install_count: sql`install_count - ${install ? 1 : 0}`, active_install_count: sql`active_install_count - ${install?.uninstalled_at === null ? 1 : 0}`,
        rating_sum: sql`rating_sum - ${rating?.stars ?? 0}`, rating_count: sql`rating_count - ${rating ? 1 : 0}`,
        ...(listing.publisher_clerk_user_id === owner ? { status: 'delisted' as const, publisher_clerk_user_id: anonymous, publisher_handle: 'deleted-publisher', updated_at: new Date().toISOString() } : {}),
      }).where('id', '=', listing.id).execute();
      await trx.executor.deleteFrom('app_store_installs').where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).execute();
      await trx.executor.deleteFrom('app_store_ratings').where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).execute();
      if (listing.publisher_clerk_user_id === owner) {
        await trx.executor.deleteFrom('app_store_versions').where('listing_id', '=', listing.id).where('status', 'not in', ['published', 'superseded']).execute();
        // Explicit account-erasure exception to ordinary append-only moderation.
        await trx.executor.updateTable('app_store_moderation_events').set({ message: null }).where('listing_id', '=', listing.id).execute();
      }
    }
    if (affected.length < 100) break; cursor = affected[affected.length - 1].id;
  }
  await trx.executor.updateTable('app_store_versions').set({ submitted_by_clerk_user_id: anonymous, generalization_report: { ai: 'unavailable', changes: [] }, reviewer_message: null,
    upload_cleaned_at: new Date().toISOString(), submission_key: sql`'deleted:' || id`, source_object_key: sql`'app-store/deleted/' || id`, scan_report: null })
    .where('submitted_by_clerk_user_id', '=', owner).execute();
  await trx.executor.updateTable('app_store_versions').set({ decided_by_clerk_user_id: anonymous }).where('decided_by_clerk_user_id', '=', owner).execute();
  await trx.executor.updateTable('app_store_moderation_events').set({ actor_clerk_user_id: anonymous, message: null }).where('actor_clerk_user_id', '=', owner).execute();
}
export async function exportAppStoreOwnerData(db: PlatformDB, owner: string) {
  const present = await sql<{ present: boolean }>`SELECT to_regclass('app_store_listings') IS NOT NULL AS present`.execute(db.executor);
  if (!present.rows[0]?.present) return { listings: [], versions: [], installs: [], ratings: [] };
  const listings = await db.executor.selectFrom('app_store_listings').selectAll().where('publisher_clerk_user_id', '=', owner).limit(10001).execute();
  const versions = await db.executor.selectFrom('app_store_versions').selectAll().where('submitted_by_clerk_user_id', '=', owner).limit(10001).execute();
  const installs = await db.executor.selectFrom('app_store_installs').selectAll().where('clerk_user_id', '=', owner).limit(10001).execute();
  const ratings = await db.executor.selectFrom('app_store_ratings').selectAll().where('clerk_user_id', '=', owner).limit(10001).execute();
  if ([listings, versions, installs, ratings].some(rows => rows.length > 10000)) throw new Error('Platform export capacity exceeded');
  return { listings, versions, installs, ratings };
}
