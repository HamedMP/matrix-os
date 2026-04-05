import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  createInstallation,
  getByUserAndListing,
  listByUser,
  deleteInstallation,
  incrementInstallCount,
} from '../../../packages/platform/src/gallery/installations.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/installations', () => {
  let db: Kysely<GalleryDatabase>;
  const userId = '00000000-0000-0000-0000-000000000001';
  const userId2 = '00000000-0000-0000-0000-000000000002';
  let listingId: string;
  let versionId: string;

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
      slug: 'install-test-app',
      name: 'Install Test App',
      author_id: '00000000-0000-0000-0000-000000000099',
      description: 'Test',
      category: 'utility',
    }).returningAll().executeTakeFirstOrThrow();
    listingId = listing.id;

    const version = await db.insertInto('app_versions').values({
      listing_id: listingId,
      version: '1.0.0',
      manifest: JSON.stringify({ name: 'Install Test App' }),
    }).returningAll().executeTakeFirstOrThrow();
    versionId = version.id;
  });

  describe('createInstallation', () => {
    it('creates an installation record', async () => {
      const install = await createInstallation(db, {
        listing_id: listingId,
        version_id: versionId,
        user_id: userId,
        install_target: 'personal',
        permissions_granted: ['fs.read'],
      });

      expect(install.id).toBeDefined();
      expect(install.listing_id).toBe(listingId);
      expect(install.user_id).toBe(userId);
      expect(install.install_target).toBe('personal');
      expect(install.status).toBe('active');
    });

    it('rejects duplicate user+listing installs', async () => {
      await createInstallation(db, {
        listing_id: listingId,
        version_id: versionId,
        user_id: userId,
        install_target: 'personal',
      });

      await expect(
        createInstallation(db, {
          listing_id: listingId,
          version_id: versionId,
          user_id: userId,
          install_target: 'personal',
        }),
      ).rejects.toThrow();
    });
  });

  describe('getByUserAndListing', () => {
    it('returns an existing installation', async () => {
      await createInstallation(db, {
        listing_id: listingId,
        version_id: versionId,
        user_id: userId,
        install_target: 'personal',
      });

      const result = await getByUserAndListing(db, userId, listingId);
      expect(result).toBeDefined();
      expect(result!.user_id).toBe(userId);
    });

    it('returns null when not installed', async () => {
      const result = await getByUserAndListing(db, userId, listingId);
      expect(result).toBeNull();
    });
  });

  describe('listByUser', () => {
    it('returns all installations for a user', async () => {
      await createInstallation(db, {
        listing_id: listingId,
        version_id: versionId,
        user_id: userId,
        install_target: 'personal',
      });

      const installs = await listByUser(db, userId);
      expect(installs.length).toBe(1);
      expect(installs[0].listing_id).toBe(listingId);
    });

    it('returns empty for user with no installs', async () => {
      const installs = await listByUser(db, userId2);
      expect(installs.length).toBe(0);
    });
  });

  describe('deleteInstallation', () => {
    it('deletes an installation by id', async () => {
      const install = await createInstallation(db, {
        listing_id: listingId,
        version_id: versionId,
        user_id: userId,
        install_target: 'personal',
      });

      await deleteInstallation(db, install.id);
      const result = await getByUserAndListing(db, userId, listingId);
      expect(result).toBeNull();
    });
  });

  describe('incrementInstallCount', () => {
    it('increments the listing installs_count', async () => {
      const before = await db.selectFrom('app_listings')
        .select('installs_count')
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(before.installs_count).toBe(0);

      await incrementInstallCount(db, listingId);

      const after = await db.selectFrom('app_listings')
        .select('installs_count')
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(after.installs_count).toBe(1);
    });
  });
});
