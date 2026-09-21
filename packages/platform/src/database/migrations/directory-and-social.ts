import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateDirectoryAndSocial(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS port_assignments (
      port INTEGER PRIMARY KEY,
      handle TEXT UNIQUE
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS device_codes (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      clerk_user_id TEXT,
      runtime_slot TEXT,
      runtime_handle TEXT,
      expires_at BIGINT NOT NULL,
      last_polled_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE device_codes ADD COLUMN IF NOT EXISTS runtime_slot TEXT`.execute(db);
  await sql`ALTER TABLE device_codes ADD COLUMN IF NOT EXISTS runtime_handle TEXT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_device_codes_expires_at ON device_codes(expires_at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS matrix_users (
      handle TEXT PRIMARY KEY,
      human_matrix_id TEXT NOT NULL,
      ai_matrix_id TEXT NOT NULL,
      human_access_token TEXT NOT NULL,
      ai_access_token TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_matrix_human_id ON matrix_users(human_matrix_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_matrix_ai_id ON matrix_users(ai_matrix_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS apps_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      author_id TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'utility',
      tags TEXT,
      version TEXT DEFAULT '1.0.0',
      source_url TEXT,
      manifest TEXT,
      screenshots TEXT,
      installs INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 0,
      ratings_count INTEGER NOT NULL DEFAULT 0,
      forks_count INTEGER NOT NULL DEFAULT 0,
      is_public BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(author_id, slug)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_category ON apps_registry(category)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_public ON apps_registry(is_public)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_installs ON apps_registry(installs)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS app_ratings (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(app_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS app_installs (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      UNIQUE(app_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      media_urls TEXT,
      app_ref TEXT,
      likes_count INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_author ON social_posts(author_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_type ON social_posts(type)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_created ON social_posts(created_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_likes ON social_posts(likes_count)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_comments_post ON social_comments(post_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      following_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(follower_id, following_id)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_follower ON social_follows(follower_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_following ON social_follows(following_id)`.execute(db);
}
