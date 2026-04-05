import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  createOrg,
  getOrgBySlug,
  getOrgById,
  updateOrg,
  deleteOrg,
  listOrgsForUser,
  getMemberCount,
  getOrgAppCount,
  listOrgApps,
} from '../../../packages/platform/src/gallery/organizations.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;
const USER_A = '00000000-0000-0000-0000-000000000001';
const USER_B = '00000000-0000-0000-0000-000000000002';

describe.skipIf(!TEST_DB_URL)('gallery/organizations - CRUD', () => {
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
    await db.deleteFrom('org_memberships').execute();
    await db.deleteFrom('app_listings').execute();
    await db.deleteFrom('organizations').execute();
  });

  describe('createOrg', () => {
    it('creates org and owner membership in one transaction', async () => {
      const org = await createOrg(db, {
        slug: 'test-org',
        name: 'Test Org',
        ownerId: USER_A,
      });

      expect(org.slug).toBe('test-org');
      expect(org.name).toBe('Test Org');
      expect(org.owner_id).toBe(USER_A);
      expect(org.id).toBeTruthy();

      const members = await db
        .selectFrom('org_memberships')
        .selectAll()
        .where('org_id', '=', org.id)
        .execute();

      expect(members).toHaveLength(1);
      expect(members[0].user_id).toBe(USER_A);
      expect(members[0].role).toBe('owner');
      expect(members[0].status).toBe('active');
      expect(members[0].joined_at).toBeTruthy();
    });

    it('creates org with optional description', async () => {
      const org = await createOrg(db, {
        slug: 'desc-org',
        name: 'Desc Org',
        description: 'A description',
        ownerId: USER_A,
      });

      expect(org.description).toBe('A description');
    });

    it('rejects duplicate slug', async () => {
      await createOrg(db, { slug: 'dup', name: 'First', ownerId: USER_A });
      await expect(
        createOrg(db, { slug: 'dup', name: 'Second', ownerId: USER_B }),
      ).rejects.toThrow();
    });
  });

  describe('getOrgBySlug', () => {
    it('returns org by slug', async () => {
      await createOrg(db, { slug: 'find-me', name: 'Find Me', ownerId: USER_A });
      const org = await getOrgBySlug(db, 'find-me');
      expect(org).toBeTruthy();
      expect(org!.slug).toBe('find-me');
    });

    it('returns undefined for non-existent slug', async () => {
      const org = await getOrgBySlug(db, 'nope');
      expect(org).toBeUndefined();
    });
  });

  describe('getOrgById', () => {
    it('returns org by id', async () => {
      const created = await createOrg(db, { slug: 'by-id', name: 'By Id', ownerId: USER_A });
      const org = await getOrgById(db, created.id);
      expect(org).toBeTruthy();
      expect(org!.id).toBe(created.id);
    });
  });

  describe('updateOrg', () => {
    it('updates name', async () => {
      await createOrg(db, { slug: 'upd', name: 'Old Name', ownerId: USER_A });
      const updated = await updateOrg(db, 'upd', { name: 'New Name' });
      expect(updated!.name).toBe('New Name');
    });

    it('updates description', async () => {
      await createOrg(db, { slug: 'upd-desc', name: 'Org', ownerId: USER_A });
      const updated = await updateOrg(db, 'upd-desc', { description: 'New desc' });
      expect(updated!.description).toBe('New desc');
    });

    it('returns undefined for non-existent org', async () => {
      const result = await updateOrg(db, 'nope', { name: 'X' });
      expect(result).toBeUndefined();
    });
  });

  describe('deleteOrg', () => {
    it('deletes org and its memberships', async () => {
      await createOrg(db, { slug: 'del', name: 'Delete Me', ownerId: USER_A });
      const deleted = await deleteOrg(db, 'del');
      expect(deleted).toBe(true);

      const org = await getOrgBySlug(db, 'del');
      expect(org).toBeUndefined();

      const members = await db
        .selectFrom('org_memberships')
        .selectAll()
        .execute();
      expect(members).toHaveLength(0);
    });

    it('returns false for non-existent org', async () => {
      const deleted = await deleteOrg(db, 'nope');
      expect(deleted).toBe(false);
    });
  });

  describe('listOrgsForUser', () => {
    it('lists orgs where user is active member', async () => {
      const org1 = await createOrg(db, { slug: 'org1', name: 'Org 1', ownerId: USER_A });
      const org2 = await createOrg(db, { slug: 'org2', name: 'Org 2', ownerId: USER_A });
      await createOrg(db, { slug: 'org3', name: 'Org 3', ownerId: USER_B });

      const orgs = await listOrgsForUser(db, USER_A);
      expect(orgs).toHaveLength(2);
      const slugs = orgs.map((o) => o.slug);
      expect(slugs).toContain('org1');
      expect(slugs).toContain('org2');
    });

    it('includes role in result', async () => {
      await createOrg(db, { slug: 'role-org', name: 'Role Org', ownerId: USER_A });
      const orgs = await listOrgsForUser(db, USER_A);
      expect(orgs[0].role).toBe('owner');
    });

    it('returns empty array for user with no orgs', async () => {
      const orgs = await listOrgsForUser(db, USER_A);
      expect(orgs).toHaveLength(0);
    });
  });

  describe('getMemberCount', () => {
    it('counts active members', async () => {
      const org = await createOrg(db, { slug: 'cnt', name: 'Count', ownerId: USER_A });
      const count = await getMemberCount(db, org.id);
      expect(count).toBe(1);
    });
  });

  describe('getOrgAppCount', () => {
    it('counts org apps', async () => {
      const org = await createOrg(db, { slug: 'apps', name: 'Apps', ownerId: USER_A });
      const count = await getOrgAppCount(db, org.id);
      expect(count).toBe(0);
    });
  });

  describe('listOrgApps', () => {
    it('returns org-scoped listings', async () => {
      const org = await createOrg(db, { slug: 'la', name: 'LA', ownerId: USER_A });

      await db.insertInto('app_listings').values({
        slug: 'org-app-1',
        name: 'Org App 1',
        author_id: USER_A,
        org_id: org.id,
        visibility: 'organization',
      }).execute();

      await db.insertInto('app_listings').values({
        slug: 'public-app',
        name: 'Public App',
        author_id: USER_A,
      }).execute();

      const apps = await listOrgApps(db, org.id);
      expect(apps).toHaveLength(1);
      expect(apps[0].slug).toBe('org-app-1');
    });
  });
});
