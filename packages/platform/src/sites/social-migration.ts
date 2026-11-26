import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';

/** Independently versioned so preview startup cannot invalidate serving invitation readers. */
export async function migrateSiteSocial(db: PlatformMigrationExecutor): Promise<void> {
    await sql`ALTER TABLE public_sites
      ADD COLUMN IF NOT EXISTS social_title TEXT CHECK (social_title IS NULL OR char_length(social_title) BETWEEN 1 AND 200),
      ADD COLUMN IF NOT EXISTS social_description TEXT CHECK (social_description IS NULL OR char_length(social_description) BETWEEN 1 AND 1000),
      ADD COLUMN IF NOT EXISTS social_image_path TEXT CHECK (social_image_path IS NULL OR char_length(social_image_path) <= 240)`.execute(db);
}
