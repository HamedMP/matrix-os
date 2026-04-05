import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';
import {
  createOrg,
  getOrgBySlug,
  updateOrg,
  deleteOrg,
  listOrgsForUser,
  inviteMember,
  acceptInvitation,
  declineInvitation,
  removeMember,
  updateMemberRole,
  listMembers,
  getMembership,
  checkRole,
  getMemberCount,
  getOrgAppCount,
  listOrgApps,
  type OrgRole,
} from './organizations.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function createOrgApi(db: Kysely<GalleryDatabase>): Hono {
  const api = new Hono();

  // Auth helper: extract userId from platform-verified header
  // NEVER read x-user-id -- it's client-controlled and spoofable.
  function getUserId(c: import('hono').Context): string | null {
    return c.req.header('x-platform-user-id') ?? null;
  }

  function requireAuth(c: import('hono').Context): string | Response {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return userId;
  }

  // --- Org CRUD ---

  api.post('/orgs', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const body = await c.req.json<{ name?: string; slug?: string; description?: string }>();
    if (!body.name) {
      return c.json({ error: 'name is required' }, 400);
    }

    const slug = body.slug ?? slugify(body.name);

    try {
      const org = await createOrg(db, {
        slug,
        name: body.name,
        description: body.description,
        ownerId: userId,
      });
      return c.json({ id: org.id, slug: org.slug, name: org.name }, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        return c.json({ error: 'Slug already taken' }, 409);
      }
      throw err;
    }
  });

  api.get('/orgs', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgs = await listOrgsForUser(db, userId);
    const summaries = await Promise.all(
      orgs.map(async (o) => {
        const memberCount = await getMemberCount(db, o.id);
        return {
          id: o.id,
          slug: o.slug,
          name: o.name,
          memberCount,
          role: o.role,
        };
      }),
    );
    return c.json({ orgs: summaries });
  });

  api.get('/orgs/:orgSlug', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    const membership = await getMembership(db, org.id, userId);
    if (!membership || membership.status !== 'active') {
      return c.json({ error: 'Not a member' }, 403);
    }

    const memberCount = await getMemberCount(db, org.id);
    const appCount = await getOrgAppCount(db, org.id);

    return c.json({
      id: org.id,
      slug: org.slug,
      name: org.name,
      description: org.description,
      ownerId: org.owner_id,
      memberCount,
      appCount,
      createdAt: org.created_at,
    });
  });

  api.put('/orgs/:orgSlug', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    if (!(await checkRole(db, org.id, userId, 'admin'))) {
      return c.json({ error: 'Insufficient role' }, 403);
    }

    const body = await c.req.json<{ name?: string; description?: string }>();
    const updated = await updateOrg(db, orgSlug, body);
    return c.json(updated);
  });

  api.delete('/orgs/:orgSlug', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    if (org.owner_id !== userId) {
      return c.json({ error: 'Only owner can delete' }, 403);
    }

    await deleteOrg(db, orgSlug);
    return c.json({ deleted: true });
  });

  // --- Membership ---

  api.post('/orgs/:orgSlug/members', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    if (!(await checkRole(db, org.id, userId, 'admin'))) {
      return c.json({ error: 'Insufficient role' }, 403);
    }

    const body = await c.req.json<{ userId?: string; role?: OrgRole }>();
    if (!body.userId) {
      return c.json({ error: 'userId is required' }, 400);
    }

    const membership = await inviteMember(db, {
      orgId: org.id,
      userId: body.userId,
      role: body.role,
      invitedBy: userId,
    });

    if (!membership) {
      return c.json({ error: 'Already a member' }, 409);
    }

    return c.json({ membershipId: membership.id, status: membership.status }, 201);
  });

  api.get('/orgs/:orgSlug/members', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    const membership = await getMembership(db, org.id, userId);
    if (!membership || membership.status !== 'active') {
      return c.json({ error: 'Not a member' }, 403);
    }

    const members = await listMembers(db, org.id);
    return c.json({
      members: members.map((m) => ({
        id: m.id,
        userId: m.user_id,
        role: m.role,
        status: m.status,
        joinedAt: m.joined_at,
      })),
    });
  });

  api.put('/orgs/:orgSlug/members/:userId', async (c) => {
    const requesterId = requireAuth(c);
    if (requesterId instanceof Response) return requesterId;

    const orgSlug = c.req.param('orgSlug');
    const targetUserId = c.req.param('userId');

    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    if (!(await checkRole(db, org.id, requesterId, 'admin'))) {
      return c.json({ error: 'Insufficient role' }, 403);
    }

    const body = await c.req.json<{ role: OrgRole }>();
    const updated = await updateMemberRole(db, org.id, targetUserId, body.role);
    if (!updated) {
      return c.json({ error: 'Cannot update role' }, 400);
    }

    return c.json({ id: updated.id, userId: updated.user_id, role: updated.role, status: updated.status });
  });

  api.delete('/orgs/:orgSlug/members/:userId', async (c) => {
    const requesterId = requireAuth(c);
    if (requesterId instanceof Response) return requesterId;

    const orgSlug = c.req.param('orgSlug');
    const targetUserId = c.req.param('userId');

    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    // Allow self-removal (leaving) or admin+ removing others
    const isSelf = requesterId === targetUserId;
    if (!isSelf && !(await checkRole(db, org.id, requesterId, 'admin'))) {
      return c.json({ error: 'Insufficient role' }, 403);
    }

    // Cannot remove owner
    const target = await getMembership(db, org.id, targetUserId);
    if (target?.role === 'owner') {
      return c.json({ error: 'Cannot remove owner' }, 403);
    }

    await removeMember(db, org.id, targetUserId);
    return c.json({ removed: true });
  });

  api.post('/orgs/:orgSlug/members/accept', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    const accepted = await acceptInvitation(db, org.id, userId);
    if (!accepted) {
      return c.json({ error: 'No pending invitation' }, 404);
    }

    return c.json({
      id: accepted.id,
      userId: accepted.user_id,
      role: accepted.role,
      status: accepted.status,
      joinedAt: accepted.joined_at,
    });
  });

  api.post('/orgs/:orgSlug/members/decline', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    await declineInvitation(db, org.id, userId);
    return c.json({ declined: true });
  });

  // --- Org Apps ---

  api.get('/orgs/:orgSlug/apps', async (c) => {
    const userId = requireAuth(c);
    if (userId instanceof Response) return userId;

    const orgSlug = c.req.param('orgSlug');
    const org = await getOrgBySlug(db, orgSlug);
    if (!org) return c.json({ error: 'Not found' }, 404);

    const membership = await getMembership(db, org.id, userId);
    if (!membership || membership.status !== 'active') {
      return c.json({ error: 'Not a member' }, 403);
    }

    const apps = await listOrgApps(db, org.id);
    return c.json({
      apps: apps.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        category: a.category,
        iconUrl: a.icon_url,
        installsCount: a.installs_count,
        avgRating: a.avg_rating,
        ratingsCount: a.ratings_count,
      })),
    });
  });

  return api;
}
