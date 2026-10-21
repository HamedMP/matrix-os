import { AppStoreManifestSchema, canonicalJson, compareStoreStorage, type AppStoreScanReport } from '@matrix-os/contracts/app-store';
import { bundleDigest, decodeAppBundle, AppBundleError } from '@matrix-os/contracts/app-store-bundle';
import { scanAppFiles } from '@matrix-os/contracts/app-store-scan';
import type { PlatformDB } from '../db.js';
import type { AppStoreRepository } from './repository.js';
import type { StoreObjects } from './object-store.js';
import { storeSourceKey } from './storage-keys.js';
import { AppStoreError } from './errors.js';
export function createStoreIntake(db: PlatformDB, repository: AppStoreRepository, objects: StoreObjects) {
  return async function finalize(owner: string, versionId: string, ownerTerms: string[]) {
    const version = await repository.beginScan(owner, versionId);
    try {
      const bytes = await objects.read(version.source_object_key, version.source_size);
      if (bundleDigest(bytes) !== version.source_sha256) throw new AppStoreError('invalid');
      const decoded = decodeAppBundle(bytes, { kind: 'source' });
      let manifest: unknown; let packageJson: unknown;
      try { manifest = JSON.parse(decoded.files.get('matrix.json')!.toString('utf8')); packageJson = JSON.parse(decoded.files.get('package.json')!.toString('utf8')); }
      catch (error) { if (error instanceof SyntaxError) throw new AppStoreError('invalid'); throw error; }
      const parsed = AppStoreManifestSchema.safeParse(manifest);
      if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(version.manifest)) throw new AppStoreError('invalid');
      const report = scanAppFiles(decoded.files, { ownerTerms });
      const add = (rule: string, message: string) => {
        if (report.findings.length < 500) report.findings.push({ rule, category: 'policy', severity: 'high', file: 'package.json', message });
        else report.truncated = true;
        report.blocking = true;
      };
      if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) throw new AppStoreError('invalid');
      const pkg = packageJson as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      if (!(pkg.dependencies?.vite || pkg.devDependencies?.vite)) add('policy.vite_required', 'A declared Vite dependency is required');
      if (!decoded.files.has('pnpm-lock.yaml')) add('policy.lockfile_required', 'A pnpm lockfile is required');
      const listing = await db.executor.selectFrom('app_store_listings').select('current_version_id').where('id', '=', version.listing_id).executeTakeFirstOrThrow();
      if (listing.current_version_id) {
        const previous = await repository.getVersion(listing.current_version_id);
        if (!compareStoreStorage(previous.manifest.storage, version.manifest.storage).ok) add('policy.storage_not_additive', 'Updates must preserve existing data columns');
      }
      report.blocking ||= report.truncated;
      const immutableKey = storeSourceKey(version.submitted_by_clerk_user_id, version.id, version.source_sha256);
      // Never serve the author-writable upload key: its presigned PUT may remain valid.
      if (!report.blocking) await objects.write(immutableKey, bytes);
      return await repository.completeScan(versionId, report, report.blocking ? undefined : immutableKey);
    } catch (error) {
      if (error instanceof AppStoreError && error.code === 'invalid' || error instanceof AppBundleError) {
        const report: AppStoreScanReport = { blocking: true, truncated: false, findings: [{ rule: 'policy.bundle_invalid', category: 'policy', severity: 'high', file: 'matrix.json', message: 'The source bundle could not be verified' }] };
        return repository.completeScan(versionId, report);
      }
      await repository.resetScan(versionId); throw error;
    }
  };
}
