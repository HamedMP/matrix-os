import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  createOrg,
  inviteMember,
  acceptInvitation,
  listOrgApps,
} from '../../../packages/platform/src/gallery/organizations.js';
import {
  filterListingsByVisibility,
} from '../../../packages/platform/src/gallery/org-visibility.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;
const OWNER = '00000000-0000-0000-0000-000000000001';
const MEMBER = '00000000-0000-0000-0000-000000000002';
const OUTSIDER = '00000000-0000-0000-0000-000000000003';

describe.skipIf(!TEST_DB_URL)('gallery/org-visibility', () => {
  let db: Kysely<GalleryDatabase>;
  let orgId: string;

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
    await db.deleteFrom('org_memberships').execute();
    await db.deleteFrom('app_listings').execute();
    await db.deleteFrom('organizations').execute();

    const org = await createOrg(db, { slug: 'vis-org', name: 'Vis Org', ownerId: OWNER });
    orgId = org.id;
    await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
    await acceptInvitation(db, orgId, MEMBER);

    // Seed listings with different visibility
    await db.insertInto('app_listings').values({
      slug: 'public-app',
      name: 'Public App',
      author_id: OWNER,
      visibility: 'public',
    }).execute();

    await db.insertInto('app_listings').values({
      slug: 'org-app',
      name: 'Org App',
      author_id: OWNER,
      visibility: 'organization',
      org_id: orgId,
    }).execute();

    await db.insertInto('app_listings').values({
      slug: 'unlisted-app',
      name: 'Unlisted App',
      author_id: OWNER,
      visibility: 'unlisted',
    }).execute();
  });

  describe('filterListingsByVisibility', () => {
    it('returns public listings for anonymous users', async () => {
      const listings = await filterListingsByVisibility(db, { userId: undefined });
      const slugs = listings.map((l) => l.slug);
      expect(slugs).toContain('public-app');
      expect(slugs).not.toContain('org-app');
      expect(slugs).not.toContain('unlisted-app');
    });

    it('returns public + org listings for org member', async () => {
      const listings = await filterListingsByVisibility(db, { userId: MEMBER });
      const slugs = listings.map((l) => l.slug);
      expect(slugs).toContain('public-app');
      expect(slugs).toContain('org-app');
      expect(slugs).not.toContain('unlisted-app');
    });

    it('returns only public listings for non-member authenticated user', async () => {
      const listings = await filterListingsByVisibility(db, { userId: OUTSIDER });
      const slugs = listings.map((l) => l.slug);
      expect(slugs).toContain('public-app');
      expect(slugs).not.toContain('org-app');
      expect(slugs).not.toContain('unlisted-app');
    });

    it('returns org-private app for org owner', async () => {
      const listings = await filterListingsByVisibility(db, { userId: OWNER });
      const slugs = listings.map((l) => l.slug);
      expect(slugs).toContain('org-app');
    });
  });

  describe('listOrgApps', () => {
    it('returns only org-scoped apps', async () => {
      const apps = await listOrgApps(db, orgId);
      expect(apps).toHaveLength(1);
      expect(apps[0].slug).toBe('org-app');
    });
  });
});
