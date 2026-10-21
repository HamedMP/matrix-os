import { capabilitiesDigest, compareSemver, compareStoreStorage, type AppStoreReviewDecision, type AppStoreListingAction, type AppStoreReviewQueueItem } from '@matrix-os/contracts/app-store';
import { signStoreApproval } from '@matrix-os/contracts/app-store-signing';
import type { PlatformDB } from '../db.js';
import type { StoreListingRow, StoreVersionRow } from './types.js';
import { AppStoreError } from './errors.js';
import { appendStoreEvent } from './repository-events.js';
import { getStoreVersion, storeSummary, storeOffset, storeCursor } from './repository-listings.js';
export interface StoreRepositoryOptions { signing?: { keyId: string; privateKey: string }; now?: () => string }
export function reviewItem(version: StoreVersionRow, listing: StoreListingRow): AppStoreReviewQueueItem {
  const findings = version.scan_report?.findings ?? [];
  return { versionId: version.id, listingId: listing.id, listingSlug: listing.slug, name: version.name, version: version.version, status: version.status,
    publisherHandle: listing.publisher_handle, isUpdate: listing.current_version_id !== null, submittedAt: version.created_at, updatedAt: version.updated_at,
    scan: { blocking: version.scan_report?.blocking ?? true, high: findings.filter(f => f.severity === 'high').length,
      medium: findings.filter(f => f.severity === 'medium').length, low: findings.filter(f => f.severity === 'low').length },
    integrationCount: version.capabilities.integrations.required.length + version.capabilities.integrations.optional.length };
}
export function createReviewRepository(db: PlatformDB, options: StoreRepositoryOptions, now: () => string) {
  async function decide(reviewer: string, versionId: string, decision: AppStoreReviewDecision) {
    return db.transaction(async trx => {
      const candidate = await getStoreVersion(trx, versionId);
      const listing = await trx.executor.selectFrom('app_store_listings').selectAll().where('id', '=', candidate.listing_id).forUpdate().executeTakeFirstOrThrow();
      const version = await getStoreVersion(trx, versionId);
      if (version.status !== 'in_review') throw new AppStoreError('conflict');
      if (listing.publisher_clerk_user_id === reviewer) throw new AppStoreError('forbidden');
      const time = now();
      let approval: { keyId: string; signature: string } | undefined;
      if (decision.type === 'approve') {
        if (!options.signing) throw new AppStoreError('unavailable');
        if (!version.scan_report || version.scan_report.blocking) throw new AppStoreError('conflict');
        const previous = listing.current_version_id ? await getStoreVersion(trx, listing.current_version_id) : null;
        if (previous && (compareSemver(version.version, previous.version) <= 0 || !compareStoreStorage(previous.manifest.storage, version.manifest.storage).ok)) throw new AppStoreError('conflict');
        try { approval = signStoreApproval({ versionId: version.id, version: version.version, source: { sha256: version.source_sha256, size: version.source_size },
          capabilitiesDigest: await capabilitiesDigest(version.capabilities), manifest: version.manifest }, options.signing); }
        catch (error) { console.error('[app-store] Source signing failed', error); throw new AppStoreError('unavailable'); }
        if (previous) await trx.executor.updateTable('app_store_versions').set({ status: 'superseded', updated_at: time }).where('id', '=', previous.id).where('status', '=', 'published').execute();
        await trx.executor.updateTable('app_store_listings').set({ current_version_id: version.id, status: listing.status === 'pending' ? 'live' : listing.status,
          name: version.name, tagline: version.tagline, description: version.description, category: version.category, updated_at: time }).where('id', '=', listing.id).execute();
      }
      const result = await trx.executor.updateTable('app_store_versions').set({ status: decision.type === 'approve' ? 'published' : decision.type === 'reject' ? 'rejected' : 'changes_requested',
        reviewer_message: decision.message ?? null, decided_by_clerk_user_id: reviewer, decided_at: time, updated_at: time,
        ...(approval ? { approval_key_id: approval.keyId, approval_signature: approval.signature, published_at: time } : {}) })
        .where('id', '=', versionId).where('status', '=', 'in_review').returningAll().executeTakeFirst();
      if (!result) throw new AppStoreError('conflict');
      await appendStoreEvent(trx, { actor_kind: 'reviewer', actor_clerk_user_id: reviewer, action: decision.type, listing_id: listing.id, version_id: versionId, message: decision.message ?? null }, time);
      return reviewItem(result, listing);
    });
  }
  async function listingAction(reviewer: string, listingId: string, action: AppStoreListingAction) {
    return db.transaction(async trx => {
      const listing = await trx.executor.selectFrom('app_store_listings').selectAll().where('id', '=', listingId).forUpdate().executeTakeFirst();
      if (!listing) throw new AppStoreError('not_found');
      if (listing.publisher_clerk_user_id === reviewer) throw new AppStoreError('forbidden');
      if (!listing.current_version_id || (action.type === 'reinstate' && !['suspended', 'delisted'].includes(listing.status))) throw new AppStoreError('conflict');
      const status = action.type === 'reinstate' ? 'live' : action.type === 'delist' ? 'delisted' : 'suspended';
      if (status === listing.status) throw new AppStoreError('conflict');
      const updated = await trx.executor.updateTable('app_store_listings').set({ status, updated_at: now() }).where('id', '=', listing.id).where('status', '=', listing.status).returningAll().executeTakeFirstOrThrow();
      await appendStoreEvent(trx, { actor_kind: 'reviewer', actor_clerk_user_id: reviewer, action: action.type, listing_id: listingId, version_id: null, message: action.message }, now());
      return storeSummary(updated, await getStoreVersion(trx, listing.current_version_id));
    });
  }
  async function queue(status: 'in_review' | 'changes_requested', cursor?: string) {
    const offset = storeOffset(cursor);
    const versions = await db.executor.selectFrom('app_store_versions').selectAll().where('status', '=', status).orderBy('created_at').orderBy('id').offset(offset).limit(51).execute();
    const items = await Promise.all(versions.slice(0, 50).map(async version => reviewItem(version, await db.executor.selectFrom('app_store_listings').selectAll().where('id', '=', version.listing_id).executeTakeFirstOrThrow())));
    return { items, ...(versions.length > 50 ? { nextCursor: storeCursor(offset + 50) } : {}) };
  }
  return { decide, listingAction, queue };
}
