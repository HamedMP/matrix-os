import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';
export async function migrateSites(db: PlatformMigrationExecutor): Promise<void> {
    await sql `CREATE TABLE IF NOT EXISTS public_sites (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, machine_id TEXT NOT NULL, app_slug TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL, slug TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), status TEXT NOT NULL CHECK (status IN ('published','unpublished')),
  active_version TEXT, created_at TEXT NOT NULL, UNIQUE(owner_id,machine_id,app_slug)
 )`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_versions (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES public_sites(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, config JSONB NOT NULL, files JSONB NOT NULL
 )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_versions_site ON public_site_versions(site_id,created_at)`.execute(db);
    // Prior aliases remain owned by the site to prevent link takeover.
    await sql `CREATE TABLE IF NOT EXISTS public_site_aliases (
  slug TEXT PRIMARY KEY, site_id TEXT REFERENCES public_sites(id) ON DELETE SET NULL
 )`.execute(db);
}
