import type { PlatformDB } from '../db.js';
import { createListingRepository, getStoreVersion, storeMetrics, storeOffset, storeCursor } from './repository-listings.js';
import { createVersionRepository, submissionSummary } from './repository-versions.js';
import { createCommunityRepository } from './repository-community.js';
import { createReviewRepository, type StoreRepositoryOptions } from './repository-review.js';
import { storeEvents } from './repository-events.js';
export function createAppStoreRepository(db: PlatformDB, options: StoreRepositoryOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  async function submissions(owner: string, cursor?: string) {
    const offset = storeOffset(cursor);
    const versions = await db.executor.selectFrom('app_store_versions').selectAll().where('submitted_by_clerk_user_id', '=', owner).orderBy('created_at', 'desc').orderBy('id').offset(offset).limit(101).execute();
    const listings = await db.executor.selectFrom('app_store_listings').selectAll().where('publisher_clerk_user_id', '=', owner).orderBy('updated_at', 'desc').orderBy('id').limit(100).execute();
    const submissionRows = await Promise.all(versions.slice(0, 100).map(async version => {
      const listing = await db.executor.selectFrom('app_store_listings').select('slug').where('id', '=', version.listing_id).executeTakeFirstOrThrow();
      return submissionSummary(version, listing.slug);
    }));
    const publisherRows = await Promise.all(listings.map(async listing => ({ id: listing.id, slug: listing.slug, name: listing.name, status: listing.status,
      currentVersion: listing.current_version_id ? (await getStoreVersion(db, listing.current_version_id)).version : null, ...storeMetrics(listing) })));
    return { submissions: submissionRows, listings: publisherRows, ...(versions.length > 100 ? { nextCursor: storeCursor(offset + 100) } : {}) };
  }
  return { ...createListingRepository(db), ...createVersionRepository(db, now), ...createCommunityRepository(db, now), ...createReviewRepository(db, options, now),
    submissions, getVersion: (id: string) => getStoreVersion(db, id), events: (listingId: string) => storeEvents(db, listingId) };
}
export type AppStoreRepository = ReturnType<typeof createAppStoreRepository>;
