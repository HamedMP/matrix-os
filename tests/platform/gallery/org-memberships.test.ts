import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  createOrg,
  inviteMember,
  acceptInvitation,
  declineInvitation,
  removeMember,
  updateMemberRole,
  listMembers,
  getMembership,
  checkRole,
  hasMinRole,
} from '../../../packages/platform/src/gallery/organizations.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;
const OWNER = '00000000-0000-0000-0000-000000000001';
const ADMIN = '00000000-0000-0000-0000-000000000002';
const MEMBER = '00000000-0000-0000-0000-000000000003';
const OUTSIDER = '00000000-0000-0000-0000-000000000004';

describe.skipIf(!TEST_DB_URL)('gallery/org-memberships', () => {
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
    await db.deleteFrom('organizations').execute();
    const org = await createOrg(db, { slug: 'test-org', name: 'Test Org', ownerId: OWNER });
    orgId = org.id;
  });

  describe('hasMinRole', () => {
    it('owner >= all roles', () => {
      expect(hasMinRole('owner', 'owner')).toBe(true);
      expect(hasMinRole('owner', 'admin')).toBe(true);
      expect(hasMinRole('owner', 'publisher')).toBe(true);
      expect(hasMinRole('owner', 'member')).toBe(true);
    });

    it('admin >= admin, publisher, member', () => {
      expect(hasMinRole('admin', 'owner')).toBe(false);
      expect(hasMinRole('admin', 'admin')).toBe(true);
      expect(hasMinRole('admin', 'publisher')).toBe(true);
      expect(hasMinRole('admin', 'member')).toBe(true);
    });

    it('publisher >= publisher, member', () => {
      expect(hasMinRole('publisher', 'admin')).toBe(false);
      expect(hasMinRole('publisher', 'publisher')).toBe(true);
      expect(hasMinRole('publisher', 'member')).toBe(true);
    });

    it('member >= member only', () => {
      expect(hasMinRole('member', 'publisher')).toBe(false);
      expect(hasMinRole('member', 'member')).toBe(true);
    });
  });

  describe('inviteMember', () => {
    it('creates a pending membership', async () => {
      const membership = await inviteMember(db, {
        orgId,
        userId: MEMBER,
        invitedBy: OWNER,
      });

      expect(membership).toBeTruthy();
      expect(membership!.status).toBe('pending');
      expect(membership!.role).toBe('member');
      expect(membership!.invited_by).toBe(OWNER);
    });

    it('defaults to member role', async () => {
      const membership = await inviteMember(db, {
        orgId,
        userId: MEMBER,
        invitedBy: OWNER,
      });
      expect(membership!.role).toBe('member');
    });

    it('accepts custom role', async () => {
      const membership = await inviteMember(db, {
        orgId,
        userId: ADMIN,
        role: 'admin',
        invitedBy: OWNER,
      });
      expect(membership!.role).toBe('admin');
    });

    it('rejects owner role invitation', async () => {
      await expect(
        inviteMember(db, { orgId, userId: MEMBER, role: 'owner', invitedBy: OWNER }),
      ).rejects.toThrow('Cannot invite as owner');
    });

    it('is idempotent (no duplicate on conflict)', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      const second = await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      // ON CONFLICT DO NOTHING returns undefined
      expect(second).toBeUndefined();
    });
  });

  describe('acceptInvitation', () => {
    it('transitions pending to active', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      const accepted = await acceptInvitation(db, orgId, MEMBER);
      expect(accepted).toBeTruthy();
      expect(accepted!.status).toBe('active');
      expect(accepted!.joined_at).toBeTruthy();
    });

    it('returns undefined if no pending invitation', async () => {
      const result = await acceptInvitation(db, orgId, OUTSIDER);
      expect(result).toBeUndefined();
    });

    it('does not accept already active membership', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, orgId, MEMBER);
      const secondAccept = await acceptInvitation(db, orgId, MEMBER);
      expect(secondAccept).toBeUndefined();
    });
  });

  describe('declineInvitation', () => {
    it('transitions pending to removed', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      const declined = await declineInvitation(db, orgId, MEMBER);
      expect(declined).toBeTruthy();
      expect(declined!.status).toBe('removed');
    });

    it('returns undefined if no pending invitation', async () => {
      const result = await declineInvitation(db, orgId, OUTSIDER);
      expect(result).toBeUndefined();
    });
  });

  describe('removeMember', () => {
    it('removes an active member', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, orgId, MEMBER);
      const removed = await removeMember(db, orgId, MEMBER);
      expect(removed).toBeTruthy();
      expect(removed!.status).toBe('removed');
    });

    it('cannot remove owner', async () => {
      const result = await removeMember(db, orgId, OWNER);
      expect(result).toBeUndefined();
    });
  });

  describe('updateMemberRole', () => {
    it('updates role of active member', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, orgId, MEMBER);
      const updated = await updateMemberRole(db, orgId, MEMBER, 'admin');
      expect(updated).toBeTruthy();
      expect(updated!.role).toBe('admin');
    });

    it('cannot change owner role', async () => {
      const result = await updateMemberRole(db, orgId, OWNER, 'admin');
      expect(result).toBeUndefined();
    });

    it('rejects assigning owner role', async () => {
      await expect(
        updateMemberRole(db, orgId, MEMBER, 'owner'),
      ).rejects.toThrow('Cannot assign owner role');
    });

    it('does not update pending membership', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      const result = await updateMemberRole(db, orgId, MEMBER, 'admin');
      expect(result).toBeUndefined();
    });
  });

  describe('listMembers', () => {
    it('lists active and pending members', async () => {
      await inviteMember(db, { orgId, userId: ADMIN, role: 'admin', invitedBy: OWNER });
      await acceptInvitation(db, orgId, ADMIN);
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });

      const members = await listMembers(db, orgId);
      expect(members).toHaveLength(3); // owner + admin + pending member
    });

    it('excludes removed members', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, orgId, MEMBER);
      await removeMember(db, orgId, MEMBER);

      const members = await listMembers(db, orgId);
      expect(members).toHaveLength(1); // owner only
    });
  });

  describe('getMembership', () => {
    it('returns membership for user', async () => {
      const membership = await getMembership(db, orgId, OWNER);
      expect(membership).toBeTruthy();
      expect(membership!.role).toBe('owner');
    });

    it('returns undefined for non-member', async () => {
      const result = await getMembership(db, orgId, OUTSIDER);
      expect(result).toBeUndefined();
    });
  });

  describe('checkRole', () => {
    it('returns true when user has sufficient role', async () => {
      expect(await checkRole(db, orgId, OWNER, 'admin')).toBe(true);
      expect(await checkRole(db, orgId, OWNER, 'owner')).toBe(true);
    });

    it('returns false when user lacks role', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      await acceptInvitation(db, orgId, MEMBER);
      expect(await checkRole(db, orgId, MEMBER, 'admin')).toBe(false);
    });

    it('returns false for non-member', async () => {
      expect(await checkRole(db, orgId, OUTSIDER, 'member')).toBe(false);
    });

    it('returns false for pending member', async () => {
      await inviteMember(db, { orgId, userId: MEMBER, invitedBy: OWNER });
      expect(await checkRole(db, orgId, MEMBER, 'member')).toBe(false);
    });
  });
});
