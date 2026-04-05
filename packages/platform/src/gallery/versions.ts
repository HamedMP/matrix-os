import { type Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';

interface CreateVersionInput {
  listing_id: string;
  version: string;
  changelog?: string;
  manifest: unknown;
  bundle_path?: string;
}

export async function createVersion(
  db: Kysely<GalleryDatabase>,
  input: CreateVersionInput,
) {
  return db.insertInto('app_versions')
    .values({
      listing_id: input.listing_id,
      version: input.version,
      changelog: input.changelog ?? null,
      manifest: JSON.stringify(input.manifest),
      bundle_path: input.bundle_path ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getCurrentVersion(
  db: Kysely<GalleryDatabase>,
  listingId: string,
) {
  const result = await db.selectFrom('app_versions')
    .selectAll()
    .where('listing_id', '=', listingId)
    .where('is_current', '=', true)
    .executeTakeFirst();

  return result ?? null;
}

export async function listVersions(
  db: Kysely<GalleryDatabase>,
  listingId: string,
) {
  return db.selectFrom('app_versions')
    .selectAll()
    .where('listing_id', '=', listingId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function setCurrent(
  db: Kysely<GalleryDatabase>,
  listingId: string,
  versionId: string,
) {
  await db.transaction().execute(async (tx) => {
    // Unmark all versions for this listing
    await tx.updateTable('app_versions')
      .set({ is_current: false })
      .where('listing_id', '=', listingId)
      .execute();

    // Mark the target version as current
    await tx.updateTable('app_versions')
      .set({ is_current: true })
      .where('id', '=', versionId)
      .execute();

    // Update the listing's current_version_id pointer
    await tx.updateTable('app_listings')
      .set({ current_version_id: versionId, updated_at: new Date() })
      .where('id', '=', listingId)
      .execute();
  });
}

export async function updateAuditStatus(
  db: Kysely<GalleryDatabase>,
  versionId: string,
  auditStatus: string,
  auditFindings?: unknown,
) {
  const values: Record<string, unknown> = { audit_status: auditStatus };
  if (auditFindings !== undefined) {
    values.audit_findings = JSON.stringify(auditFindings);
  }
  return db.updateTable('app_versions')
    .set(values)
    .where('id', '=', versionId)
    .execute();
}
