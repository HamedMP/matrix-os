import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import { createOrgApi } from '../../../packages/platform/src/gallery/org-api.js';
import { createOrg, inviteMember, acceptInvitation } from '../../../packages/platform/src/gallery/organizations.js';
import { Hono } from 'hono';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;
const OWNER = '00000000-0000-0000-0000-000000000001';
const ADMIN = '00000000-0000-0000-0000-000000000002';
const MEMBER = '00000000-0000-0000-0000-000000000003';
const OUTSIDER = '00000000-0000-0000-0000-000000000004';

describe.skipIf(!TEST_DB_URL)('gallery/org-api', () => {
  let db: Kysely<GalleryDatabase>;
  let app: Hono;

  function request(path: string, opts?: { method?: string; body?: unknown; userId?: string }) {
    const method = opts?.method ?? 'GET';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts?.userId) headers['x-user-id'] = opts.userId;
    return app.request(path, {
      method,
      headers,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
  }

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

    const parent = new Hono();
    parent.route('/api/store', createOrgApi(db));
    app = parent;
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

  describe('POST /api/store/orgs', () => {
    it('creates org and returns 201', async () => {
      const res = await request('/api/store/orgs', {
        method: 'POST',
        userId: OWNER,
        body: { name: 'My Org', slug: 'my-org' },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.slug).toBe('my-org');
      expect(data.name).toBe('My Org');
      expect(data.id).toBeTruthy();
    });

    it('returns 401 without auth', async () => {
      const res = await request('/api/store/orgs', {
        method: 'POST',
        body: { name: 'X', slug: 'x' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 without name', async () => {
      const res = await request('/api/store/orgs', {
        method: 'POST',
        userId: OWNER,
        body: { slug: 'no-name' },
      });
      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate slug', async () => {
      await request('/api/store/orgs', {
        method: 'POST',
        userId: OWNER,
        body: { name: 'First', slug: 'dup' },
      });
      const res = await request('/api/store/orgs', {
        method: 'POST',
        userId: OWNER,
        body: { name: 'Second', slug: 'dup' },
      });
      expect(res.status).toBe(409);
    });

    it('auto-generates slug from name if not provided', async () => {
      const res = await request('/api/store/orgs', {
        method: 'POST',
        userId: OWNER,
        body: { name: 'My Cool Org' },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.slug).toBe('my-cool-org');
    });
  });

  describe('GET /api/store/orgs', () => {
    it('lists user orgs', async () => {
      await createOrg(db, { slug: 'o1', name: 'O1', ownerId: OWNER });
      await createOrg(db, { slug: 'o2', name: 'O2', ownerId: OWNER });
      await createOrg(db, { slug: 'o3', name: 'O3', ownerId: ADMIN });

      const res = await request('/api/store/orgs', { userId: OWNER });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.orgs).toHaveLength(2);
    });

    it('returns 401 without auth', async () => {
      const res = await request('/api/store/orgs');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/store/orgs/:orgSlug', () => {
    it('returns org details for member', async () => {
      await createOrg(db, { slug: 'detail', name: 'Detail Org', ownerId: OWNER });
      const res = await request('/api/store/orgs/detail', { userId: OWNER });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slug).toBe('detail');
      expect(data.name).toBe('Detail Org');
      expect(typeof data.memberCount).toBe('number');
    });

    it('returns 403 for non-member', async () => {
      await createOrg(db, { slug: 'private', name: 'Private', ownerId: OWNER });
      const res = await request('/api/store/orgs/private', { userId: OUTSIDER });
      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent org', async () => {
      const res = await request('/api/store/orgs/nope', { userId: OWNER });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/store/orgs/:orgSlug', () => {
    it('updates org for admin+', async () => {
      await createOrg(db, { slug: 'upd', name: 'Old', ownerId: OWNER });
      const res = await request('/api/store/orgs/upd', {
        method: 'PUT',
        userId: OWNER,
        body: { name: 'New Name' },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe('New Name');
    });

    it('returns 403 for member role', async () => {
      const org = await createOrg(db, { slug: 'no-upd', name: 'No', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, org.id, MEMBER);

      const res = await request('/api/store/orgs/no-upd', {
        method: 'PUT',
        userId: MEMBER,
        body: { name: 'Hacked' },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/store/orgs/:orgSlug', () => {
    it('deletes org for owner', async () => {
      await createOrg(db, { slug: 'del', name: 'Del', ownerId: OWNER });
      const res = await request('/api/store/orgs/del', {
        method: 'DELETE',
        userId: OWNER,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deleted).toBe(true);
    });

    it('returns 403 for admin (not owner)', async () => {
      const org = await createOrg(db, { slug: 'no-del', name: 'No Del', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: ADMIN, role: 'admin', invitedBy: OWNER });
      await acceptInvitation(db, org.id, ADMIN);

      const res = await request('/api/store/orgs/no-del', {
        method: 'DELETE',
        userId: ADMIN,
      });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/store/orgs/:orgSlug/members', () => {
    it('invites a user', async () => {
      await createOrg(db, { slug: 'inv', name: 'Inv', ownerId: OWNER });
      const res = await request('/api/store/orgs/inv/members', {
        method: 'POST',
        userId: OWNER,
        body: { userId: MEMBER, role: 'member' },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.status).toBe('pending');
    });

    it('returns 403 for non-admin', async () => {
      const org = await createOrg(db, { slug: 'no-inv', name: 'No Inv', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, org.id, MEMBER);

      const res = await request('/api/store/orgs/no-inv/members', {
        method: 'POST',
        userId: MEMBER,
        body: { userId: OUTSIDER },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/store/orgs/:orgSlug/members', () => {
    it('lists members for org member', async () => {
      await createOrg(db, { slug: 'lm', name: 'LM', ownerId: OWNER });
      const res = await request('/api/store/orgs/lm/members', { userId: OWNER });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.members).toHaveLength(1);
    });
  });

  describe('PUT /api/store/orgs/:orgSlug/members/:userId', () => {
    it('updates role', async () => {
      const org = await createOrg(db, { slug: 'ur', name: 'UR', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, org.id, MEMBER);

      const res = await request(`/api/store/orgs/ur/members/${MEMBER}`, {
        method: 'PUT',
        userId: OWNER,
        body: { role: 'publisher' },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.role).toBe('publisher');
    });
  });

  describe('DELETE /api/store/orgs/:orgSlug/members/:userId', () => {
    it('removes member', async () => {
      const org = await createOrg(db, { slug: 'rm', name: 'RM', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, org.id, MEMBER);

      const res = await request(`/api/store/orgs/rm/members/${MEMBER}`, {
        method: 'DELETE',
        userId: OWNER,
      });
      expect(res.status).toBe(200);
    });

    it('allows member to leave', async () => {
      const org = await createOrg(db, { slug: 'leave', name: 'Leave', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, org.id, MEMBER);

      const res = await request(`/api/store/orgs/leave/members/${MEMBER}`, {
        method: 'DELETE',
        userId: MEMBER,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/store/orgs/:orgSlug/members/accept', () => {
    it('accepts pending invitation', async () => {
      const org = await createOrg(db, { slug: 'acc', name: 'Acc', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: MEMBER, invitedBy: OWNER });

      const res = await request('/api/store/orgs/acc/members/accept', {
        method: 'POST',
        userId: MEMBER,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('active');
    });

    it('returns 404 when no pending invitation', async () => {
      await createOrg(db, { slug: 'no-acc', name: 'No Acc', ownerId: OWNER });
      const res = await request('/api/store/orgs/no-acc/members/accept', {
        method: 'POST',
        userId: OUTSIDER,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/store/orgs/:orgSlug/members/decline', () => {
    it('declines pending invitation', async () => {
      const org = await createOrg(db, { slug: 'dec', name: 'Dec', ownerId: OWNER });
      await inviteMember(db, { orgId: org.id, userId: MEMBER, invitedBy: OWNER });

      const res = await request('/api/store/orgs/dec/members/decline', {
        method: 'POST',
        userId: MEMBER,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.declined).toBe(true);
    });
  });

  describe('GET /api/store/orgs/:orgSlug/apps', () => {
    it('returns org apps for member', async () => {
      const org = await createOrg(db, { slug: 'oa', name: 'OA', ownerId: OWNER });

      await db.insertInto('app_listings').values({
        slug: 'org-app',
        name: 'Org App',
        author_id: OWNER,
        org_id: org.id,
        visibility: 'organization',
      }).execute();

      const res = await request('/api/store/orgs/oa/apps', { userId: OWNER });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.apps).toHaveLength(1);
    });

    it('returns 403 for non-member', async () => {
      await createOrg(db, { slug: 'oa2', name: 'OA2', ownerId: OWNER });
      const res = await request('/api/store/orgs/oa2/apps', { userId: OUTSIDER });
      expect(res.status).toBe(403);
    });
  });
});
