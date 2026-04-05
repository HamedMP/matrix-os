import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  getInstallationsWithUpdateStatus,
  markInstallationUpdated,
  getPreviousVersion,
} from '../../../packages/platform/src/gallery/update-detection.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

const USER_ID = '00000000-0000-0000-0000-000000000001';
const AUTHOR_ID = '00000000-0000-0000-0000-000000000002';

describe.skipIf(!TEST_DB_URL)('gallery/update-detection', () => {
  let db: Kysely<GalleryDatabase>;

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
    await db.deleteFrom('app_installations').execute();
    await db.deleteFrom('app_versions').execute();
    await db.deleteFrom('app_listings').execute();
  });

  async function seedListingWithVersions() {
    const listing = await db
      .insertInto('app_listings')
      .values({
        slug: 'test-app',
        name: 'Test App',
        author_id: AUTHOR_ID,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const v1 = await db
      .insertInto('app_versions')
      .values({
        listing_id: listing.id,
        version: '1.0.0',
        manifest: JSON.stringify({ name: 'Test App' }),
        is_current: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const v2 = await db
      .insertInto('app_versions')
      .values({
        listing_id: listing.id,
        version: '2.0.0',
        manifest: JSON.stringify({ name: 'Test App v2' }),
        is_current: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable('app_listings')
      .set({ current_version_id: v2.id })
      .where('id', '=', listing.id)
      .execute();

    return { listing, v1, v2 };
  }

  describe('getInstallationsWithUpdateStatus', () => {
    it('returns empty array when user has no installations', async () => {
      const result = await getInstallationsWithUpdateStatus(db, USER_ID);
      expect(result).toEqual([]);
    });

    it('flags installation as hasUpdate when installed version differs from current', async () => {
      const { listing, v1, v2 } = await seedListingWithVersions();

      await db
        .insertInto('app_installations')
        .values({
          listing_id: listing.id,
          version_id: v1.id,
          user_id: USER_ID,
          install_target: 'personal',
        })
        .execute();

      const result = await getInstallationsWithUpdateStatus(db, USER_ID);
      expect(result).toHaveLength(1);
      expect(result[0].hasUpdate).toBe(true);
      expect(result[0].installedVersion).toBe('1.0.0');
      expect(result[0].currentVersion).toBe('2.0.0');
      expect(result[0].listingSlug).toBe('test-app');
    });

    it('does not flag when installed version matches current', async () => {
      const { listing, v2 } = await seedListingWithVersions();

      await db
        .insertInto('app_installations')
        .values({
          listing_id: listing.id,
          version_id: v2.id,
          user_id: USER_ID,
          install_target: 'personal',
        })
        .execute();

      const result = await getInstallationsWithUpdateStatus(db, USER_ID);
      expect(result).toHaveLength(1);
      expect(result[0].hasUpdate).toBe(false);
      expect(result[0].installedVersion).toBe('2.0.0');
      expect(result[0].currentVersion).toBe('2.0.0');
    });

    it('handles multiple installations with mixed update states', async () => {
      const { listing: listing1, v1, v2 } = await seedListingWithVersions();

      const listing2 = await db
        .insertInto('app_listings')
        .values({
          slug: 'another-app',
          name: 'Another App',
          author_id: AUTHOR_ID,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const v1b = await db
        .insertInto('app_versions')
        .values({
          listing_id: listing2.id,
          version: '1.0.0',
          manifest: JSON.stringify({ name: 'Another' }),
          is_current: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await db
        .updateTable('app_listings')
        .set({ current_version_id: v1b.id })
        .where('id', '=', listing2.id)
        .execute();

      // Install listing1 at v1 (outdated), listing2 at v1b (current)
      await db
        .insertInto('app_installations')
        .values([
          {
            listing_id: listing1.id,
            version_id: v1.id,
            user_id: USER_ID,
            install_target: 'personal',
          },
          {
            listing_id: listing2.id,
            version_id: v1b.id,
            user_id: USER_ID,
            install_target: 'personal',
          },
        ])
        .execute();

      const result = await getInstallationsWithUpdateStatus(db, USER_ID);
      expect(result).toHaveLength(2);

      const testApp = result.find((r) => r.listingSlug === 'test-app');
      const anotherApp = result.find((r) => r.listingSlug === 'another-app');

      expect(testApp?.hasUpdate).toBe(true);
      expect(anotherApp?.hasUpdate).toBe(false);
    });

    it('handles listing with no current_version_id gracefully', async () => {
      const listing = await db
        .insertInto('app_listings')
        .values({
          slug: 'no-version-app',
          name: 'No Version App',
          author_id: AUTHOR_ID,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const v1 = await db
        .insertInto('app_versions')
        .values({
          listing_id: listing.id,
          version: '1.0.0',
          manifest: JSON.stringify({ name: 'Test' }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await db
        .insertInto('app_installations')
        .values({
          listing_id: listing.id,
          version_id: v1.id,
          user_id: USER_ID,
          install_target: 'personal',
        })
        .execute();

      const result = await getInstallationsWithUpdateStatus(db, USER_ID);
      expect(result).toHaveLength(1);
      expect(result[0].hasUpdate).toBe(false);
    });
  });

  describe('markInstallationUpdated', () => {
    it('updates version_id and updated_at on the installation', async () => {
      const { listing, v1, v2 } = await seedListingWithVersions();

      const inst = await db
        .insertInto('app_installations')
        .values({
          listing_id: listing.id,
          version_id: v1.id,
          user_id: USER_ID,
          install_target: 'personal',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await markInstallationUpdated(db, inst.id, v2.id);

      const updated = await db
        .selectFrom('app_installations')
        .selectAll()
        .where('id', '=', inst.id)
        .executeTakeFirstOrThrow();

      expect(updated.version_id).toBe(v2.id);
      expect(updated.status).toBe('active');
      expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
        new Date(inst.updated_at).getTime() - 1000
      );
    });
  });

  describe('getPreviousVersion', () => {
    it('returns the version before the current one by created_at', async () => {
      const { listing, v1, v2 } = await seedListingWithVersions();

      const prev = await getPreviousVersion(db, listing.id, v2.id);
      expect(prev).not.toBeNull();
      expect(prev!.id).toBe(v1.id);
      expect(prev!.version).toBe('1.0.0');
    });

    it('returns null when there is no previous version', async () => {
      const { listing, v1 } = await seedListingWithVersions();

      const prev = await getPreviousVersion(db, listing.id, v1.id);
      expect(prev).toBeNull();
    });

    it('returns correct previous when there are multiple versions', async () => {
      const { listing, v1, v2 } = await seedListingWithVersions();

      const v3 = await db
        .insertInto('app_versions')
        .values({
          listing_id: listing.id,
          version: '3.0.0',
          manifest: JSON.stringify({ name: 'Test App v3' }),
          is_current: false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const prevOfV3 = await getPreviousVersion(db, listing.id, v3.id);
      expect(prevOfV3).not.toBeNull();
      expect(prevOfV3!.id).toBe(v2.id);

      const prevOfV2 = await getPreviousVersion(db, listing.id, v2.id);
      expect(prevOfV2).not.toBeNull();
      expect(prevOfV2!.id).toBe(v1.id);
    });
  });
});
