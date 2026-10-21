import { createHash } from 'node:crypto';
import { decodeAppBundle, validateBundlePath, AppBundleError } from '@matrix-os/contracts/app-store-bundle';
import type { AppStoreReviewDetail } from '@matrix-os/contracts/app-store';
import type { PlatformDB } from '../db.js';
import type { AppStoreRepository } from './repository.js';
import type { StoreObjects } from './object-store.js';
import { AppStoreError } from './errors.js';
import { reviewItem } from './repository-review.js';
export function createReviewService(db: PlatformDB, repository: AppStoreRepository, objects: StoreObjects) {
  async function context(versionId: string) {
    const version = await repository.getVersion(versionId);
    const listing = await db.executor.selectFrom('app_store_listings').selectAll().where('id', '=', version.listing_id).executeTakeFirstOrThrow();
    const previous = await db.executor.selectFrom('app_store_versions').selectAll().where('listing_id', '=', listing.id)
      .where('status', 'in', ['published', 'superseded']).where(eb => eb.or([
        eb('version_major', '<', version.version_major),
        eb.and([eb('version_major', '=', version.version_major), eb('version_minor', '<', version.version_minor)]),
        eb.and([eb('version_major', '=', version.version_major), eb('version_minor', '=', version.version_minor), eb('version_patch', '<', version.version_patch)]),
      ])).orderBy('version_major', 'desc').orderBy('version_minor', 'desc').orderBy('version_patch', 'desc').limit(1).executeTakeFirst();
    return { version, listing, previous };
  }
  async function files(version: Awaited<ReturnType<AppStoreRepository['getVersion']>>) {
    if (!version.source_object_key.startsWith('app-store/owners/') || !version.source_object_key.includes('/sources/')) throw new AppStoreError('conflict');
    const bytes = await objects.read(version.source_object_key, version.source_size);
    if (createHash('sha256').update(bytes).digest('hex') !== version.source_sha256) throw new AppStoreError('unavailable');
    return decodeAppBundle(bytes, { kind: 'source' });
  }
  async function detail(versionId: string): Promise<AppStoreReviewDetail> {
    const { version, listing, previous } = await context(versionId);
    const current = await files(version); const old = previous ? await files(previous) : null;
    const oldEntries = old?.entries ?? [];
    return { item: reviewItem(version, listing), listing: { id: listing.id, slug: listing.slug, status: listing.status, currentVersion: listing.current_version_id ? (await repository.getVersion(listing.current_version_id)).version : null },
      proposed: { name: version.name, tagline: version.tagline, description: version.description, category: version.category, changelog: version.changelog, license: version.license },
      capabilities: version.capabilities, previousCapabilities: previous?.capabilities ?? null, scanReport: version.scan_report, generalizationReport: version.generalization_report,
      files: current.entries.map(entry => ({ path: entry.path, size: entry.size, sha256: entry.sha256,
        change: !old?.files.has(entry.path) ? 'added' : oldEntries.find(item => item.path === entry.path)?.sha256 === entry.sha256 ? 'unchanged' : 'modified' })),
      removedFiles: oldEntries.filter(entry => !current.files.has(entry.path)).map(entry => entry.path),
      events: (await repository.events(listing.id)).map(event => ({ action: event.action, actorKind: event.actor_kind, message: event.message, createdAt: event.created_at })) };
  }
  async function file(versionId: string, path: string, previous = false) {
    try { validateBundlePath(path, 'source'); } catch (error) { if (error instanceof AppBundleError) throw new AppStoreError('invalid'); throw error; }
    const ctx = await context(versionId); const version = previous ? ctx.previous : ctx.version;
    if (!version) throw new AppStoreError('not_found');
    const decoded = await files(version); const bytes = decoded.files.get(path); if (!bytes) throw new AppStoreError('not_found');
    const binary = bytes.subarray(0, 8192).includes(0); const truncated = bytes.length > 512 * 1024;
    return { path, size: bytes.length, binary, truncated, ...(binary ? {} : { text: bytes.subarray(0, 512 * 1024).toString('utf8') }) };
  }
  return { detail, file, files };
}
