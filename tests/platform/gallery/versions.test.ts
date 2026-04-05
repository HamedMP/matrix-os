import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  createVersion,
  getCurrentVersion,
  listVersions,
  setCurrent,
} from '../../../packages/platform/src/gallery/versions.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/versions', () => {
  let db: Kysely<GalleryDatabase>;
  let listingId: string;

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    db = new Kysely<GalleryDatabase>({ dialect: new PostgresDialect({ pool }) });

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

  beforeEach(async () => {
    await sql`DELETE FROM app_installations`.execute(db);
    await sql`DELETE FROM app_versions`.execute(db);
    await sql`UPDATE app_listings SET current_version_id = NULL`.execute(db);
    await sql`DELETE FROM app_listings`.execute(db);

    const listing = await db.insertInto('app_listings').values({
      slug: 'version-test-app',
      name: 'Version Test App',
      author_id: '00000000-0000-0000-0000-000000000001',
      description: 'Test',
      category: 'utility',
    }).returningAll().executeTakeFirstOrThrow();
    listingId = listing.id;
  });

  describe('createVersion', () => {
    it('creates a version record', async () => {
      const version = await createVersion(db, {
        listing_id: listingId,
        version: '1.0.0',
        changelog: 'Initial release',
        manifest: { name: 'Version Test App' },
      });

      expect(version.id).toBeDefined();
      expect(version.listing_id).toBe(listingId);
      expect(version.version).toBe('1.0.0');
      expect(version.audit_status).toBe('pending');
      expect(version.is_current).toBe(false);
    });

    it('rejects duplicate version numbers for same listing', async () => {
      await createVersion(db, {
        listing_id: listingId,
        version: '1.0.0',
        manifest: { name: 'Test' },
      });

      await expect(
        createVersion(db, {
          listing_id: listingId,
          version: '1.0.0',
          manifest: { name: 'Test' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('getCurrentVersion', () => {
    it('returns the current version', async () => {
      const v1 = await createVersion(db, {
        listing_id: listingId,
        version: '1.0.0',
        manifest: { name: 'Test' },
      });
      await setCurrent(db, listingId, v1.id);

      const current = await getCurrentVersion(db, listingId);
      expect(current).toBeDefined();
      expect(current!.version).toBe('1.0.0');
      expect(current!.is_current).toBe(true);
    });

    it('returns null when no current version', async () => {
      const current = await getCurrentVersion(db, listingId);
      expect(current).toBeNull();
    });
  });

  describe('listVersions', () => {
    it('returns all versions for a listing', async () => {
      await createVersion(db, { listing_id: listingId, version: '1.0.0', manifest: {} });
      await createVersion(db, { listing_id: listingId, version: '2.0.0', manifest: {} });

      const versions = await listVersions(db, listingId);
      expect(versions.length).toBe(2);
    });

    it('returns newest first', async () => {
      await createVersion(db, { listing_id: listingId, version: '1.0.0', manifest: {} });
      await createVersion(db, { listing_id: listingId, version: '2.0.0', manifest: {} });

      const versions = await listVersions(db, listingId);
      expect(versions[0].version).toBe('2.0.0');
    });
  });

  describe('setCurrent', () => {
    it('marks a version as current and unmarks others', async () => {
      const v1 = await createVersion(db, { listing_id: listingId, version: '1.0.0', manifest: {} });
      const v2 = await createVersion(db, { listing_id: listingId, version: '2.0.0', manifest: {} });

      await setCurrent(db, listingId, v1.id);
      let current = await getCurrentVersion(db, listingId);
      expect(current!.version).toBe('1.0.0');

      await setCurrent(db, listingId, v2.id);
      current = await getCurrentVersion(db, listingId);
      expect(current!.version).toBe('2.0.0');

      // v1 should no longer be current
      const v1After = await db.selectFrom('app_versions')
        .selectAll()
        .where('id', '=', v1.id)
        .executeTakeFirst();
      expect(v1After!.is_current).toBe(false);
    });

    it('updates listing current_version_id', async () => {
      const v1 = await createVersion(db, { listing_id: listingId, version: '1.0.0', manifest: {} });
      await setCurrent(db, listingId, v1.id);

      const listing = await db.selectFrom('app_listings')
        .select('current_version_id')
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(listing.current_version_id).toBe(v1.id);
    });
  });
});
