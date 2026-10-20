import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';
export async function migrateAppStore(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS app_store_listings (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, publisher_clerk_user_id TEXT NOT NULL, publisher_handle TEXT NOT NULL,
    name TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','live','delisted','suspended')), current_version_id TEXT,
    install_count INTEGER NOT NULL DEFAULT 0 CHECK(install_count >= 0), active_install_count INTEGER NOT NULL DEFAULT 0 CHECK(active_install_count >= 0),
    rating_sum INTEGER NOT NULL DEFAULT 0 CHECK(rating_sum >= 0), rating_count INTEGER NOT NULL DEFAULT 0 CHECK(rating_count >= 0),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS app_store_versions (
    id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES app_store_listings(id), version TEXT NOT NULL,
    version_major INTEGER NOT NULL, version_minor INTEGER NOT NULL, version_patch INTEGER NOT NULL,
    submission_key TEXT NOT NULL UNIQUE, submitted_by_clerk_user_id TEXT NOT NULL, submission_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('awaiting_upload','scanning','scan_failed','in_review','changes_requested','rejected','published','superseded','withdrawn')),
    name TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, changelog TEXT NOT NULL, license TEXT NOT NULL,
    capabilities JSONB NOT NULL, capabilities_digest TEXT NOT NULL, manifest JSONB NOT NULL,
    source_object_key TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_size INTEGER NOT NULL CHECK(source_size > 0 AND source_size <= 16777216),
    approval_key_id TEXT, approval_signature TEXT, scan_report JSONB, generalization_report JSONB NOT NULL,
    reviewer_message TEXT, decided_by_clerk_user_id TEXT, decided_at TEXT, scanning_started_at TEXT, published_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(listing_id,version), CHECK(status NOT IN ('published','superseded') OR (approval_key_id IS NOT NULL AND approval_signature IS NOT NULL))
  )`.execute(db);
  await sql`ALTER TABLE app_store_versions ADD COLUMN IF NOT EXISTS upload_cleaned_at TEXT`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS app_store_installs (
    listing_id TEXT NOT NULL REFERENCES app_store_listings(id), clerk_user_id TEXT NOT NULL,
    version_id TEXT NOT NULL REFERENCES app_store_versions(id), first_installed_at TEXT NOT NULL, last_installed_at TEXT NOT NULL, uninstalled_at TEXT,
    PRIMARY KEY(listing_id,clerk_user_id)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS app_store_ratings (
    listing_id TEXT NOT NULL REFERENCES app_store_listings(id), clerk_user_id TEXT NOT NULL, stars SMALLINT NOT NULL CHECK(stars BETWEEN 1 AND 5),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(listing_id,clerk_user_id)
  )`.execute(db);
  // Events deliberately retain version IDs when abandoned uploads are purged.
  await sql`CREATE TABLE IF NOT EXISTS app_store_moderation_events (
    id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('reviewer','publisher','system')),
    actor_clerk_user_id TEXT, action TEXT NOT NULL, listing_id TEXT NOT NULL REFERENCES app_store_listings(id), version_id TEXT,
    message TEXT, created_at TEXT NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS app_store_catalog_popular ON app_store_listings(status,install_count DESC,id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS app_store_catalog_new ON app_store_listings(status,created_at DESC,id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS app_store_publishers ON app_store_listings(publisher_clerk_user_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS app_store_queue ON app_store_versions(status,created_at,id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS app_store_version_order ON app_store_versions(listing_id,version_major DESC,version_minor DESC,version_patch DESC)`.execute(db);
}
