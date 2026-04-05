import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/migrations', () => {
  let db: Kysely<GalleryDatabase>;

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    db = new Kysely<GalleryDatabase>({ dialect: new PostgresDialect({ pool }) });

    // Drop all gallery tables for a clean slate
    await sql`DROP TABLE IF EXISTS org_memberships CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS security_audits CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_reviews CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_installations CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_versions CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_listings CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS organizations CASCADE`.execute(db);
    await sql`DROP FUNCTION IF EXISTS app_listings_search_vector_update CASCADE`.execute(db);

    await runGalleryMigrations(db);
  });

  afterAll(async () => {
    if (db) {
      await sql`DROP TABLE IF EXISTS org_memberships CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS security_audits CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_reviews CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_installations CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_versions CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_listings CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS organizations CASCADE`.execute(db);
      await sql`DROP FUNCTION IF EXISTS app_listings_search_vector_update CASCADE`.execute(db);
      await db.destroy();
    }
  });

  async function getColumns(tableName: string): Promise<string[]> {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName}
      ORDER BY ordinal_position
    `.execute(db);
    return result.rows.map((r) => r.column_name);
  }

  async function getIndexes(tableName: string): Promise<string[]> {
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = ${tableName}
    `.execute(db);
    return result.rows.map((r) => r.indexname);
  }

  async function hasTable(tableName: string): Promise<boolean> {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = ${tableName}
      )
    `.execute(db);
    return result.rows[0].exists;
  }

  describe('table creation', () => {
    it('creates all 7 tables', async () => {
      const tables = [
        'app_listings',
        'app_versions',
        'app_installations',
        'app_reviews',
        'security_audits',
        'organizations',
        'org_memberships',
      ];
      for (const table of tables) {
        expect(await hasTable(table)).toBe(true);
      }
    });
  });

  describe('app_listings', () => {
    it('has all required columns', async () => {
      const cols = await getColumns('app_listings');
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'slug', 'name', 'author_id', 'description', 'long_description',
        'category', 'tags', 'icon_url', 'screenshots', 'visibility', 'org_id',
        'current_version_id', 'price', 'installs_count', 'avg_rating',
        'ratings_count', 'status', 'search_vector', 'manifest',
        'created_at', 'updated_at',
      ]));
    });

    it('has required indexes', async () => {
      const indexes = await getIndexes('app_listings');
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_listings_slug',
        'idx_listings_author',
        'idx_listings_category',
        'idx_listings_visibility',
        'idx_listings_org',
        'idx_listings_search',
        'idx_listings_popular',
        'idx_listings_rated',
      ]));
    });

    it('enforces unique slug', async () => {
      const authorId = '00000000-0000-0000-0000-000000000001';
      await db.insertInto('app_listings').values({
        slug: 'dup-slug',
        name: 'App 1',
        author_id: authorId,
      }).execute();

      await expect(
        db.insertInto('app_listings').values({
          slug: 'dup-slug',
          name: 'App 2',
          author_id: authorId,
        }).execute(),
      ).rejects.toThrow();

      await db.deleteFrom('app_listings').where('slug', '=', 'dup-slug').execute();
    });

    it('auto-populates search_vector on insert via trigger', async () => {
      const authorId = '00000000-0000-0000-0000-000000000001';
      await db.insertInto('app_listings').values({
        slug: 'search-test',
        name: 'Search Test App',
        author_id: authorId,
        description: 'A test for full text search',
        tags: sql`ARRAY['test', 'search']`,
      } as any).execute();

      const result = await sql<{ sv: string }>`
        SELECT search_vector::text as sv FROM app_listings WHERE slug = 'search-test'
      `.execute(db);
      expect(result.rows[0].sv).toBeTruthy();
      expect(result.rows[0].sv).toContain('search');

      await db.deleteFrom('app_listings').where('slug', '=', 'search-test').execute();
    });

    it('defaults category to utility', async () => {
      const authorId = '00000000-0000-0000-0000-000000000001';
      const res = await db.insertInto('app_listings').values({
        slug: 'default-cat',
        name: 'Default Cat',
        author_id: authorId,
      }).returningAll().executeTakeFirstOrThrow();

      expect(res.category).toBe('utility');
      await db.deleteFrom('app_listings').where('slug', '=', 'default-cat').execute();
    });
  });

  describe('app_versions', () => {
    it('has all required columns', async () => {
      const cols = await getColumns('app_versions');
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'listing_id', 'version', 'changelog', 'manifest',
        'bundle_path', 'audit_status', 'audit_findings', 'is_current', 'created_at',
      ]));
    });

    it('enforces unique (listing_id, version)', async () => {
      const authorId = '00000000-0000-0000-0000-000000000001';
      const listing = await db.insertInto('app_listings').values({
        slug: 'ver-test',
        name: 'Version Test',
        author_id: authorId,
      }).returningAll().executeTakeFirstOrThrow();

      await db.insertInto('app_versions').values({
        listing_id: listing.id,
        version: '1.0.0',
        manifest: JSON.stringify({ name: 'Test' }),
      }).execute();

      await expect(
        db.insertInto('app_versions').values({
          listing_id: listing.id,
          version: '1.0.0',
          manifest: JSON.stringify({ name: 'Test v2' }),
        }).execute(),
      ).rejects.toThrow();

      await db.deleteFrom('app_versions').where('listing_id', '=', listing.id).execute();
      await db.deleteFrom('app_listings').where('id', '=', listing.id).execute();
    });

    it('has required indexes', async () => {
      const indexes = await getIndexes('app_versions');
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_versions_listing',
        'idx_versions_listing_current',
        'idx_versions_listing_version',
      ]));
    });
  });

  describe('app_installations', () => {
    it('has all required columns', async () => {
      const cols = await getColumns('app_installations');
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'listing_id', 'version_id', 'user_id', 'org_id',
        'install_target', 'status', 'data_location', 'permissions_granted',
        'installed_at', 'updated_at',
      ]));
    });

    it('has required indexes', async () => {
      const indexes = await getIndexes('app_installations');
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_installations_user',
        'idx_installations_listing',
        'idx_installations_unique',
      ]));
    });
  });

  describe('app_reviews', () => {
    it('has all required columns', async () => {
      const cols = await getColumns('app_reviews');
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'listing_id', 'reviewer_id', 'rating', 'body',
        'author_response', 'author_responded_at', 'flagged',
        'created_at', 'updated_at',
      ]));
    });

    it('enforces rating check constraint (1-5)', async () => {
      const authorId = '00000000-0000-0000-0000-000000000001';
      const listing = await db.insertInto('app_listings').values({
        slug: 'review-check',
        name: 'Review Check',
        author_id: authorId,
      }).returningAll().executeTakeFirstOrThrow();

      await expect(
        db.insertInto('app_reviews').values({
          listing_id: listing.id,
          reviewer_id: authorId,
          rating: 0,
        }).execute(),
      ).rejects.toThrow();

      await expect(
        db.insertInto('app_reviews').values({
          listing_id: listing.id,
          reviewer_id: authorId,
          rating: 6,
        }).execute(),
      ).rejects.toThrow();

      await db.deleteFrom('app_listings').where('id', '=', listing.id).execute();
    });

    it('enforces unique (listing_id, reviewer_id)', async () => {
      const indexes = await getIndexes('app_reviews');
      expect(indexes).toEqual(expect.arrayContaining(['idx_reviews_unique']));
    });
  });

  describe('security_audits', () => {
    it('has all required columns', async () => {
      const cols = await getColumns('security_audits');
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'version_id', 'status', 'manifest_findings',
        'static_findings', 'sandbox_findings', 'started_at',
        'completed_at', 'created_at',
      ]));
    });

    it('has required indexes', async () => {
      const indexes = await getIndexes('security_audits');
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_audits_version',
        'idx_audits_status',
      ]));
    });
  });

  describe('organizations', () => {
    it('has all required columns', async () => {
      const cols = await getColumns('organizations');
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'slug', 'name', 'description', 'owner_id',
        'created_at', 'updated_at',
      ]));
    });

    it('enforces unique slug', async () => {
      const ownerId = '00000000-0000-0000-0000-000000000001';
      await db.insertInto('organizations').values({
        slug: 'dup-org',
        name: 'Org 1',
        owner_id: ownerId,
      }).execute();

      await expect(
        db.insertInto('organizations').values({
          slug: 'dup-org',
          name: 'Org 2',
          owner_id: ownerId,
        }).execute(),
      ).rejects.toThrow();

      await db.deleteFrom('organizations').where('slug', '=', 'dup-org').execute();
    });

    it('has required indexes', async () => {
      const indexes = await getIndexes('organizations');
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_orgs_slug',
        'idx_orgs_owner',
      ]));
    });
  });

  describe('org_memberships', () => {
    it('has all required columns', async () => {
      const cols = await getColumns('org_memberships');
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'org_id', 'user_id', 'role', 'status',
        'invited_by', 'joined_at', 'created_at',
      ]));
    });

    it('enforces unique (org_id, user_id)', async () => {
      const indexes = await getIndexes('org_memberships');
      expect(indexes).toEqual(expect.arrayContaining(['idx_memberships_unique']));
    });

    it('has required indexes', async () => {
      const indexes = await getIndexes('org_memberships');
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_memberships_org',
        'idx_memberships_user',
      ]));
    });
  });

  describe('idempotency', () => {
    it('can run migrations twice without error', async () => {
      await expect(runGalleryMigrations(db)).resolves.not.toThrow();
    });
  });
});
