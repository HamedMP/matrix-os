import { createHash, randomUUID } from 'node:crypto';
import { AppStoreManifestSchema, canonicalJson, capabilitiesDigest, compareSemver, deriveAppStoreCapabilities, parseSemver,
  type AppStoreCreateSubmission, type AppStoreScanReport } from '@matrix-os/contracts/app-store';
import type { PlatformDB } from '../db.js';
import type { StoreActor, StoreVersionRow } from './types.js';
import { AppStoreError, isUniqueViolation } from './errors.js';
import { appendStoreEvent } from './repository-events.js';
import { storeUploadKey } from './storage-keys.js';
import { getStoreVersion } from './repository-listings.js';
export function submissionSummary(version: StoreVersionRow, slug: string) {
  return { versionId: version.id, listingId: version.listing_id, listingSlug: slug, name: version.name, version: version.version,
    status: version.status, reviewerMessage: version.reviewer_message, scan: version.scan_report ? { blocking: version.scan_report.blocking, findingCount: version.scan_report.findings.length } : null,
    createdAt: version.created_at, updatedAt: version.updated_at };
}
export function createVersionRepository(db: PlatformDB, now: () => string) {
  async function createSubmission(actor: StoreActor, input: AppStoreCreateSubmission) {
    const parsed = AppStoreManifestSchema.safeParse(input.manifest);
    if (!parsed.success || parsed.data.version !== input.version || (parsed.data.slug && parsed.data.slug !== input.listing.slug)) throw new AppStoreError('invalid');
    const manifest = parsed.data; const capabilities = deriveAppStoreCapabilities(manifest);
    const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const capDigest = await capabilitiesDigest(capabilities); const versionParts = parseSemver(input.version)!;
    try {
      return await db.transaction(async trx => {
        const existing = await trx.executor.selectFrom('app_store_versions').selectAll().where('submission_key', '=', input.submissionKey).executeTakeFirst();
        if (existing) {
          if (existing.submitted_by_clerk_user_id !== actor.userId || existing.submission_digest !== digest) throw new AppStoreError('conflict');
          return existing;
        }
        const time = now(); const listingId = randomUUID();
        await trx.executor.insertInto('app_store_listings').values({ id: listingId, slug: input.listing.slug, publisher_clerk_user_id: actor.userId,
          publisher_handle: actor.handle, name: input.listing.name, tagline: input.listing.tagline, description: input.listing.description, category: input.listing.category,
          status: 'pending', current_version_id: null, install_count: 0, active_install_count: 0, rating_sum: 0, rating_count: 0, created_at: time, updated_at: time })
          .onConflict(oc => oc.column('slug').doNothing()).execute();
        const listing = await trx.executor.selectFrom('app_store_listings').selectAll().where('slug', '=', input.listing.slug).forUpdate().executeTakeFirstOrThrow();
        if (listing.publisher_clerk_user_id !== actor.userId) throw new AppStoreError('conflict');
        // Recheck the idempotency key after the listing lock closes absent-row races.
        const repeated = await trx.executor.selectFrom('app_store_versions').selectAll().where('submission_key', '=', input.submissionKey).executeTakeFirst();
        if (repeated) {
          if (repeated.submitted_by_clerk_user_id !== actor.userId || repeated.submission_digest !== digest) throw new AppStoreError('conflict');
          return repeated;
        }
        const latest = await trx.executor.selectFrom('app_store_versions').select('version').where('listing_id', '=', listing.id)
          .orderBy('version_major', 'desc').orderBy('version_minor', 'desc').orderBy('version_patch', 'desc').limit(1).executeTakeFirst();
        if (latest && compareSemver(input.version, latest.version) <= 0) throw new AppStoreError('conflict');
        const pending = await trx.executor.selectFrom('app_store_versions').select('id').where('submitted_by_clerk_user_id', '=', actor.userId)
          .where('status', 'in', ['awaiting_upload', 'scanning', 'in_review', 'changes_requested']).limit(21).execute();
        if (pending.length >= 20) throw new AppStoreError('limit');
        const id = randomUUID();
        const version = await trx.executor.insertInto('app_store_versions').values({
          id, listing_id: listing.id, version: input.version, version_major: versionParts.major, version_minor: versionParts.minor, version_patch: versionParts.patch,
          submission_key: input.submissionKey, submission_digest: digest, submitted_by_clerk_user_id: actor.userId, status: 'awaiting_upload',
          name: input.listing.name, tagline: input.listing.tagline, description: input.listing.description, category: input.listing.category,
          changelog: input.changelog, license: input.license, capabilities, capabilities_digest: capDigest, manifest,
          source_object_key: storeUploadKey(actor.userId, id), upload_cleaned_at: null, source_sha256: input.source.sha256, source_size: input.source.size,
          approval_key_id: null, approval_signature: null, scan_report: null, generalization_report: input.generalizationReport,
          reviewer_message: null, decided_by_clerk_user_id: null, decided_at: null, scanning_started_at: null, published_at: null, created_at: time, updated_at: time,
        }).returningAll().executeTakeFirstOrThrow();
        await appendStoreEvent(trx, { actor_kind: 'publisher', actor_clerk_user_id: actor.userId, action: 'submitted', listing_id: listing.id, version_id: id, message: null }, time);
        return version;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppStoreError('conflict'); throw error;
    }
  }
  async function beginScan(owner: string, versionId: string) {
    return db.transaction(async trx => {
      const version = await getStoreVersion(trx, versionId);
      if (version.submitted_by_clerk_user_id !== owner) throw new AppStoreError('not_found');
      const claimed = await trx.executor.updateTable('app_store_versions').set({ status: 'scanning', scanning_started_at: now(), updated_at: now() })
        .where('id', '=', versionId).where('status', '=', 'awaiting_upload').returningAll().executeTakeFirst();
      if (!claimed) throw new AppStoreError('conflict'); return claimed;
    });
  }
  async function completeScan(versionId: string, report: AppStoreScanReport, sourceObjectKey?: string) {
    report = { ...report, blocking: report.blocking || report.truncated };
    return db.transaction(async trx => {
      const time = now();
      const version = await trx.executor.updateTable('app_store_versions').set({ status: report.blocking ? 'scan_failed' : 'in_review', scan_report: report,
        ...(sourceObjectKey ? { source_object_key: sourceObjectKey } : {}), updated_at: time, scanning_started_at: null })
        .where('id', '=', versionId).where('status', '=', 'scanning').returningAll().executeTakeFirst();
      if (!version) throw new AppStoreError('conflict');
      await appendStoreEvent(trx, { actor_kind: 'system', actor_clerk_user_id: null, action: report.blocking ? 'scan_failed' : 'scan_passed', listing_id: version.listing_id, version_id: versionId, message: null }, time);
      return version;
    });
  }
  async function resetScan(versionId: string) {
    await db.executor.updateTable('app_store_versions').set({ status: 'awaiting_upload', scanning_started_at: null, updated_at: now() }).where('id', '=', versionId).where('status', '=', 'scanning').execute();
  }
  async function withdraw(owner: string, versionId: string) {
    return db.transaction(async trx => {
      const time = now();
      const version = await trx.executor.updateTable('app_store_versions').set({ status: 'withdrawn', updated_at: time }).where('id', '=', versionId)
        .where('submitted_by_clerk_user_id', '=', owner).where('status', 'in', ['awaiting_upload', 'scan_failed', 'in_review', 'changes_requested']).returningAll().executeTakeFirst();
      if (!version) throw new AppStoreError('conflict');
      await appendStoreEvent(trx, { actor_kind: 'publisher', actor_clerk_user_id: owner, action: 'withdrawn', listing_id: version.listing_id, version_id: versionId, message: null }, time);
      return version;
    });
  }
  return { createSubmission, beginScan, completeScan, resetScan, withdraw };
}
