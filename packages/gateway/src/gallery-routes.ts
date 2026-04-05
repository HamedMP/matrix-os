import { readdirSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Kysely } from 'kysely';
import type { GalleryDatabase } from '../../platform/src/gallery/types.js';
import { installApp } from './app-fork.js';
import { validateForPublish, generateSlug } from './app-publish.js';
import { applyUpdate, rollbackUpdate, snapshotAppData } from './app-update.js';

// Install dependencies (injectable for testing)
export interface GalleryInstallDeps {
  galleryDb: Kysely<GalleryDatabase>;
  getListingById: (id: string) => Promise<any>;
  getVersionById: (id: string) => Promise<any>;
  getExistingInstall: (userId: string, listingId: string) => Promise<any>;
  createInstallation: (input: any) => Promise<any>;
  incrementInstallCount: (listingId: string) => Promise<void>;
  deleteInstallation: (id: string) => Promise<void>;
  decrementInstallCount: (listingId: string) => Promise<void>;
  copyAppFiles: (options: { sourceDir: string; homePath: string; slug: string }) => { success: boolean; targetDir?: string; error?: string };
  removeAppFiles: (appDir: string) => boolean;
}

interface InstallInput {
  listingId: string;
  userId: string;
  homePath: string;
  target: string;
  orgId?: string;
  approvedPermissions: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

export async function handleInstall(
  deps: GalleryInstallDeps,
  input: InstallInput,
): Promise<RouteResult> {
  const listing = await deps.getListingById(input.listingId);
  if (!listing) {
    return { status: 404, body: { error: 'Listing not found' } };
  }

  if (listing.status !== 'active') {
    return { status: 400, body: { error: 'Listing is not available for installation' } };
  }

  if (!listing.current_version_id) {
    return { status: 400, body: { error: 'No published version available' } };
  }

  const existing = await deps.getExistingInstall(input.userId, input.listingId);
  if (existing) {
    return { status: 409, body: { error: 'App is already installed' } };
  }

  const version = await deps.getVersionById(listing.current_version_id);
  if (!version) {
    return { status: 400, body: { error: 'Version not found' } };
  }

  // Parse manifest to get slug
  let manifest: Record<string, unknown> = {};
  try {
    manifest = typeof version.manifest === 'string' ? JSON.parse(version.manifest) : version.manifest;
  } catch {
    // fallback
  }
  const slug = listing.slug;

  // Copy app files -- fail if copy fails (don't record a phantom installation)
  const copyResult = deps.copyAppFiles({
    sourceDir: version.bundle_path ?? '',
    homePath: input.homePath,
    slug,
  });
  if (!copyResult.success) {
    return { status: 500, body: { error: copyResult.error ?? 'Failed to copy app files' } };
  }

  // Create installation record
  const installation = await deps.createInstallation({
    listing_id: input.listingId,
    version_id: version.id,
    user_id: input.userId,
    org_id: input.orgId ?? null,
    install_target: input.target,
    permissions_granted: input.approvedPermissions,
    status: 'active',
  });

  // Increment install count
  await deps.incrementInstallCount(input.listingId);

  // Check for required integrations
  const integrations = manifest.integrations as { required?: string[] } | undefined;
  const missingIntegrations = integrations?.required ?? [];

  return {
    status: 201,
    body: {
      installationId: installation.id,
      slug,
      status: missingIntegrations.length > 0 ? 'setup-required' : 'active',
      appUrl: `/a/${slug}`,
      missingIntegrations,
    },
  };
}

interface UninstallInput {
  slug: string;
  userId: string;
  homePath: string;
  installationId: string;
  preserveData: boolean;
}

export async function handleUninstall(
  deps: GalleryInstallDeps,
  input: UninstallInput,
): Promise<RouteResult> {
  // Get installation to find listing_id
  const installation = await deps.getExistingInstall(input.userId, '');

  // Remove app files
  const appDir = join(input.homePath, 'apps', input.slug);
  if (!input.preserveData) {
    deps.removeAppFiles(appDir);
  }

  // Delete installation record
  await deps.deleteInstallation(input.installationId);

  // Decrement install count
  if (installation?.listing_id) {
    await deps.decrementInstallCount(installation.listing_id);
  }

  return {
    status: 200,
    body: {
      uninstalled: true,
      dataPreserved: input.preserveData,
    },
  };
}

// Publish dependencies (injectable for testing)
export interface GalleryPublishDeps {
  galleryDb: Kysely<GalleryDatabase>;
  validateForPublish: (appDir: string) => { valid: boolean; error?: string; manifest?: any };
  createOrUpdateFromPublish: (input: any) => Promise<any>;
  createVersion: (input: any) => Promise<any>;
  runFullAudit: (db: any, versionId: string, input: any) => Promise<any>;
  setCurrent: (db: any, listingId: string, versionId: string) => Promise<void>;
  readAppFiles: (appDir: string) => Map<string, string>;
}

interface PublishInput {
  appDir: string;
  authorId: string;
  description: string;
  longDescription?: string;
  category: string;
  tags?: string[];
  screenshots?: string[];
  version: string;
  changelog?: string;
  visibility: string;
  orgId?: string;
}

export async function handlePublish(
  deps: GalleryPublishDeps,
  input: PublishInput,
): Promise<RouteResult> {
  // Step 1: Validate manifest
  const validation = deps.validateForPublish(input.appDir);
  if (!validation.valid || !validation.manifest) {
    return { status: 400, body: { error: validation.error ?? 'Manifest validation failed' } };
  }

  const manifest = validation.manifest;
  const slug = generateSlug(manifest.name) || input.appDir.split('/').pop() || 'app';

  // Step 2: Create or update listing
  const listing = await deps.createOrUpdateFromPublish({
    slug,
    name: manifest.name,
    author_id: input.authorId,
    description: input.description || manifest.description,
    long_description: input.longDescription,
    category: input.category || manifest.category || 'utility',
    tags: input.tags,
    screenshots: input.screenshots,
    visibility: input.visibility,
    org_id: input.orgId,
    manifest,
  });

  // Step 3: Create version
  const version = await deps.createVersion({
    listing_id: listing.id,
    version: input.version,
    changelog: input.changelog,
    manifest,
    bundle_path: input.appDir,
  });

  // Step 4: Run security audit
  const files = deps.readAppFiles(input.appDir);
  const auditResult = await deps.runFullAudit(deps.galleryDb, version.id, {
    manifest,
    files,
  });

  // Step 5: If audit passed, set as current version
  if (auditResult.status === 'passed') {
    await deps.setCurrent(deps.galleryDb, listing.id, version.id);
  }

  const allFindings = [
    ...(auditResult.manifestFindings ?? []),
    ...(auditResult.staticFindings ?? []),
    ...(auditResult.sandboxFindings ?? []),
  ];

  return {
    status: 201,
    body: {
      listingId: listing.id,
      versionId: version.id,
      auditStatus: auditResult.status,
      auditFindings: allFindings,
      storeUrl: `/store/${input.authorId}/${slug}`,
    },
  };
}

interface ResubmitInput {
  versionId: string;
  appDir: string;
  listingId: string;
}

export async function handleResubmit(
  deps: GalleryPublishDeps,
  input: ResubmitInput,
): Promise<RouteResult> {
  const files = deps.readAppFiles(input.appDir);

  // Re-read manifest from the app dir
  const validation = deps.validateForPublish(input.appDir);
  const manifest = validation.manifest ?? {};

  const auditResult = await deps.runFullAudit(deps.galleryDb, input.versionId, {
    manifest,
    files,
  });

  if (auditResult.status === 'passed') {
    await deps.setCurrent(deps.galleryDb, input.listingId, input.versionId);
  }

  const allFindings = [
    ...(auditResult.manifestFindings ?? []),
    ...(auditResult.staticFindings ?? []),
    ...(auditResult.sandboxFindings ?? []),
  ];

  return {
    status: 200,
    body: {
      auditStatus: auditResult.status,
      auditFindings: allFindings,
    },
  };
}

// Update dependencies (injectable for testing)
export interface GalleryUpdateDeps {
  galleryDb: Kysely<GalleryDatabase>;
  getInstallation: (userId: string, listingId: string) => Promise<any>;
  getListingById: (id: string) => Promise<any>;
  getVersionById: (id: string) => Promise<any>;
  markInstallationUpdated: (installationId: string, newVersionId: string) => Promise<void>;
  getPreviousVersion: (listingId: string, currentVersionId: string) => Promise<{ id: string; version: string; changelog: string | null } | null>;
  applyUpdate: typeof applyUpdate;
  rollbackUpdate: typeof rollbackUpdate;
  snapshotAppData: typeof snapshotAppData;
}

interface UpdateInput {
  slug: string;
  userId: string;
  homePath: string;
  listingId: string;
}

export async function handleUpdate(
  deps: GalleryUpdateDeps,
  input: UpdateInput,
): Promise<RouteResult> {
  const installation = await deps.getInstallation(input.userId, input.listingId);
  if (!installation) {
    return { status: 404, body: { error: 'App is not installed' } };
  }

  const listing = await deps.getListingById(input.listingId);
  if (!listing || !listing.current_version_id) {
    return { status: 404, body: { error: 'Listing or current version not found' } };
  }

  if (installation.version_id === listing.current_version_id) {
    return { status: 400, body: { error: 'App is already on the latest version' } };
  }

  const newVersion = await deps.getVersionById(listing.current_version_id);
  if (!newVersion || !newVersion.bundle_path) {
    return { status: 400, body: { error: 'New version bundle not available' } };
  }

  // Snapshot current data before updating
  const oldVersion = await deps.getVersionById(installation.version_id);
  const versionTag = oldVersion?.version ?? installation.version_id;
  await deps.snapshotAppData({ homePath: input.homePath, slug: input.slug, versionTag });

  // Apply filesystem update
  const updateResult = await deps.applyUpdate({
    homePath: input.homePath,
    slug: input.slug,
    newVersionBundlePath: newVersion.bundle_path,
  });

  if (!updateResult.success) {
    return { status: 500, body: { error: updateResult.error ?? 'Update failed' } };
  }

  // Update installation record
  await deps.markInstallationUpdated(installation.id, listing.current_version_id);

  return {
    status: 200,
    body: {
      updated: true,
      previousVersion: oldVersion?.version ?? null,
      newVersion: newVersion.version,
      changelog: newVersion.changelog ?? null,
    },
  };
}

interface RollbackInput {
  slug: string;
  userId: string;
  homePath: string;
  listingId: string;
}

export async function handleRollback(
  deps: GalleryUpdateDeps,
  input: RollbackInput,
): Promise<RouteResult> {
  const installation = await deps.getInstallation(input.userId, input.listingId);
  if (!installation) {
    return { status: 404, body: { error: 'App is not installed' } };
  }

  const previous = await deps.getPreviousVersion(input.listingId, installation.version_id);
  if (!previous) {
    return { status: 400, body: { error: 'No previous version to roll back to' } };
  }

  const previousVersion = await deps.getVersionById(previous.id);
  if (!previousVersion || !previousVersion.bundle_path) {
    return { status: 400, body: { error: 'Previous version bundle not available' } };
  }

  const currentVersion = await deps.getVersionById(installation.version_id);
  const versionTag = currentVersion?.version ?? installation.version_id;
  const snapshotPath = join(input.homePath, 'data', '.snapshots', `${input.slug}-${previous.version}`);

  const result = await deps.rollbackUpdate({
    homePath: input.homePath,
    slug: input.slug,
    previousVersionBundlePath: previousVersion.bundle_path,
    snapshotPath,
  });

  if (!result.success) {
    return { status: 500, body: { error: result.error ?? 'Rollback failed' } };
  }

  await deps.markInstallationUpdated(installation.id, previous.id);

  return {
    status: 200,
    body: {
      rolledBack: true,
      previousVersion: versionTag,
      restoredVersion: previous.version,
      dataRestored: result.dataRestored,
    },
  };
}

// Helper: read all scannable files from an app directory
export function readAppFiles(appDir: string): Map<string, string> {
  const files = new Map<string, string>();
  const SCANNABLE = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  function walk(dir: string, prefix: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const fullPath = join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (SCANNABLE.has(extname(entry)) && stat.size <= MAX_FILE_SIZE) {
        files.set(relativePath, readFileSync(fullPath, 'utf-8'));
      }
    }
  }

  walk(appDir, '');
  return files;
}
