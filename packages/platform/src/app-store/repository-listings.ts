import { sql } from 'kysely';
import { capabilitiesDigest, type AppStoreCatalogQuery, type AppStoreListingSummary, type AppStoreListingDetail } from '@matrix-os/contracts/app-store';
import type { PlatformDB } from '../db.js';
import type { StoreListingRow, StoreVersionRow } from './types.js';
import { AppStoreError } from './errors.js';
export async function getStoreListing(db: PlatformDB, slug: string, lock = false): Promise<StoreListingRow> {
  let query = db.executor.selectFrom('app_store_listings').selectAll().where('slug', '=', slug);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst(); if (!row) throw new AppStoreError('not_found'); return row;
}
export async function getStoreVersion(db: PlatformDB, id: string): Promise<StoreVersionRow> {
  const row = await db.executor.selectFrom('app_store_versions').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw new AppStoreError('not_found'); return row;
}
export function storeMetrics(row: StoreListingRow) {
  return { installCount: row.install_count, activeInstallCount: row.active_install_count,
    ratingAverage: row.rating_count ? row.rating_sum / row.rating_count : null, ratingCount: row.rating_count };
}
export function storeSummary(row: StoreListingRow, version: StoreVersionRow | null): AppStoreListingSummary {
  return { id: row.id, slug: row.slug, name: row.name, tagline: row.tagline, category: row.category, status: row.status,
    publisher: { handle: row.publisher_handle }, version: version?.version ?? null, hasIcon: Boolean(version?.manifest.icon),
    integrations: version ? [...version.capabilities.integrations.required.map(service => ({ service: service.service, optional: false })),
      ...version.capabilities.integrations.optional.map(service => ({ service: service.service, optional: true }))] : [],
    updatedAt: row.updated_at, ...storeMetrics(row) };
}
// Offset cursor is opaque, bounded and validated; sorting always has a unique tie-breaker.
export function storeOffset(cursor?: string): number {
  if (!cursor) return 0;
  try { const text = Buffer.from(cursor, 'base64url').toString('utf8'); if (!/^\d{1,6}$/.test(text)) throw new AppStoreError('invalid'); return Number(text); }
  catch (error) { if (error instanceof AppStoreError) throw error; throw new AppStoreError('invalid'); }
}
export const storeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
export function createListingRepository(db: PlatformDB) {
  async function catalog(query: AppStoreCatalogQuery, review = false) {
    let request = db.executor.selectFrom('app_store_listings').selectAll();
    request = review ? request.where('current_version_id', 'is not', null)
      : request.where('status', '=', 'live').where('publisher_clerk_user_id', 'not like', 'deleted:%');
    if (query.q) { const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`; request = request.where(eb => eb.or([eb('name', 'ilike', pattern), eb('tagline', 'ilike', pattern)])); }
    if (query.category) request = request.where('category', '=', query.category);
    if (query.sort === 'new') request = request.orderBy('created_at', 'desc');
    else if (query.sort === 'rating') request = request.orderBy(sql`CASE WHEN rating_count > 0 THEN rating_sum::float / rating_count ELSE 0 END`, 'desc');
    else request = request.orderBy('install_count', 'desc');
    const offset = storeOffset(query.cursor);
    const rows = await request.orderBy('id').limit(query.limit + 1).offset(offset).execute();
    const listings = await Promise.all(rows.slice(0, query.limit).map(async row => storeSummary(row, row.current_version_id ? await getStoreVersion(db, row.current_version_id) : null)));
    return { listings, ...(rows.length > query.limit ? { nextCursor: storeCursor(offset + query.limit) } : {}) };
  }
  async function detail(slug: string, owner: string): Promise<AppStoreListingDetail> {
    const row = await getStoreListing(db, slug); const publisher = row.publisher_clerk_user_id === owner;
    const install = await db.executor.selectFrom('app_store_installs').selectAll().where('listing_id', '=', row.id).where('clerk_user_id', '=', owner).executeTakeFirst();
    const removed = !publisher && Boolean(install) && ['delisted', 'suspended'].includes(row.status);
    if (row.status !== 'live' && !publisher && !removed) throw new AppStoreError('not_found');
    const version = !removed && row.current_version_id ? await getStoreVersion(db, row.current_version_id) : null;
    const rating = await db.executor.selectFrom('app_store_ratings').select('stars').where('listing_id', '=', row.id).where('clerk_user_id', '=', owner).executeTakeFirst();
    const installedVersion = install ? await getStoreVersion(db, install.version_id) : null;
    return { ...storeSummary(row, removed ? installedVersion : version), ...(removed ? { hasIcon: false } : {}), description: removed ? '' : row.description,
      currentVersion: version ? { id: version.id, version: version.version, changelog: version.changelog, license: version.license, publishedAt: version.published_at! } : null,
      capabilities: version?.capabilities ?? null, capabilitiesDigest: version ? await capabilitiesDigest(version.capabilities) : null,
      myRating: rating?.stars ?? null, myInstall: install && installedVersion ? { versionId: install.version_id, version: installedVersion.version, active: install.uninstalled_at === null } : null,
      isPublisher: publisher, ...(['delisted', 'suspended'].includes(row.status) ? { notice: 'removed' as const } : {}) };
  }
  async function downloadVersion(slug: string, owner: string, versionId: string) {
    const listing = await getStoreListing(db, slug); const version = await getStoreVersion(db, versionId);
    if (listing.status === 'suspended' || listing.publisher_clerk_user_id.startsWith('deleted:')) throw new AppStoreError('forbidden');
    if (version.listing_id !== listing.id || !['published', 'superseded'].includes(version.status)) throw new AppStoreError('not_found');
    const previous = await db.executor.selectFrom('app_store_installs').select('version_id').where('listing_id', '=', listing.id).where('clerk_user_id', '=', owner).executeTakeFirst();
    if (!(listing.status === 'live' && listing.current_version_id === version.id) && previous?.version_id !== version.id) throw new AppStoreError('forbidden');
    return version;
  }
  return { catalog: (query: AppStoreCatalogQuery) => catalog(query), reviewListings: (query: AppStoreCatalogQuery) => catalog(query, true), detail, downloadVersion };
}
