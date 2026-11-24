import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';

export const SITE_PUBLIC_DATA_REVISION = { generation: 1, fingerprint: 'public-app-sites-public-data-opt-in-v1' } as const;

/** Keep the invitation marker stable; existing links stay opted out until republished. */
export async function migrateSitePublicData(db: PlatformMigrationExecutor): Promise<void> {
    await sql`ALTER TABLE public_sites ADD COLUMN IF NOT EXISTS public_data_enabled_at TEXT`.execute(db);
}
