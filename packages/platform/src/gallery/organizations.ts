import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { GalleryDatabase } from './types.js';

export type OrgRole = 'owner' | 'admin' | 'publisher' | 'member';
export type MembershipStatus = 'pending' | 'active' | 'removed';

const ROLE_HIERARCHY: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  publisher: 2,
  member: 1,
};

export function hasMinRole(userRole: OrgRole, requiredRole: OrgRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

// --- Org CRUD ---

export async function createOrg(
  db: Kysely<GalleryDatabase>,
  data: { slug: string; name: string; description?: string; ownerId: string },
) {
  return db.transaction().execute(async (tx) => {
    const org = await tx
      .insertInto('organizations')
      .values({
        slug: data.slug,
        name: data.name,
        description: data.description ?? null,
        owner_id: data.ownerId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('org_memberships')
      .values({
        org_id: org.id,
        user_id: data.ownerId,
        role: 'owner',
        status: 'active',
        joined_at: new Date(),
      })
      .execute();

    return org;
  });
}

export async function getOrgBySlug(db: Kysely<GalleryDatabase>, slug: string) {
  return db
    .selectFrom('organizations')
    .selectAll()
    .where('slug', '=', slug)
    .executeTakeFirst();
}

export async function getOrgById(db: Kysely<GalleryDatabase>, id: string) {
  return db
    .selectFrom('organizations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function updateOrg(
  db: Kysely<GalleryDatabase>,
  slug: string,
  data: { name?: string; description?: string },
) {
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;

  return db
    .updateTable('organizations')
    .set(updates)
    .where('slug', '=', slug)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteOrg(db: Kysely<GalleryDatabase>, slug: string) {
  return db.transaction().execute(async (tx) => {
    const org = await tx
      .selectFrom('organizations')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (!org) return false;

    await tx
      .deleteFrom('org_memberships')
      .where('org_id', '=', org.id)
      .execute();

    await tx
      .deleteFrom('organizations')
      .where('id', '=', org.id)
      .execute();

    return true;
  });
}

export async function listOrgsForUser(db: Kysely<GalleryDatabase>, userId: string) {
  return db
    .selectFrom('organizations as o')
    .innerJoin('org_memberships as m', 'm.org_id', 'o.id')
    .select([
      'o.id',
      'o.slug',
      'o.name',
      'o.description',
      'o.owner_id',
      'o.created_at',
      'o.updated_at',
      'm.role',
    ])
    .where('m.user_id', '=', userId)
    .where('m.status', '=', 'active')
    .execute();
}

// --- Membership ---

export async function inviteMember(
  db: Kysely<GalleryDatabase>,
  data: { orgId: string; userId: string; role?: OrgRole; invitedBy: string },
) {
  const role = data.role ?? 'member';
  if (role === 'owner') {
    throw new Error('Cannot invite as owner');
  }

  return db
    .insertInto('org_memberships')
    .values({
      org_id: data.orgId,
      user_id: data.userId,
      role,
      status: 'pending',
      invited_by: data.invitedBy,
    })
    .onConflict((oc) =>
      oc.columns(['org_id', 'user_id']).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
}

export async function acceptInvitation(
  db: Kysely<GalleryDatabase>,
  orgId: string,
  userId: string,
) {
  return db
    .updateTable('org_memberships')
    .set({
      status: 'active',
      joined_at: new Date(),
    })
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirst();
}

export async function declineInvitation(
  db: Kysely<GalleryDatabase>,
  orgId: string,
  userId: string,
) {
  return db
    .updateTable('org_memberships')
    .set({ status: 'removed' })
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirst();
}

export async function removeMember(
  db: Kysely<GalleryDatabase>,
  orgId: string,
  userId: string,
) {
  return db
    .updateTable('org_memberships')
    .set({ status: 'removed' })
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .where('role', '!=', 'owner')
    .returningAll()
    .executeTakeFirst();
}

export async function updateMemberRole(
  db: Kysely<GalleryDatabase>,
  orgId: string,
  userId: string,
  newRole: OrgRole,
) {
  if (newRole === 'owner') {
    throw new Error('Cannot assign owner role via updateMemberRole');
  }

  return db
    .updateTable('org_memberships')
    .set({ role: newRole })
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .where('role', '!=', 'owner')
    .where('status', '=', 'active')
    .returningAll()
    .executeTakeFirst();
}

export async function listMembers(db: Kysely<GalleryDatabase>, orgId: string) {
  return db
    .selectFrom('org_memberships')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('status', 'in', ['active', 'pending'])
    .orderBy('created_at', 'asc')
    .execute();
}

export async function getMembership(
  db: Kysely<GalleryDatabase>,
  orgId: string,
  userId: string,
) {
  return db
    .selectFrom('org_memberships')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

export async function checkRole(
  db: Kysely<GalleryDatabase>,
  orgId: string,
  userId: string,
  requiredRole: OrgRole,
): Promise<boolean> {
  const membership = await getMembership(db, orgId, userId);
  if (!membership || membership.status !== 'active') return false;
  return hasMinRole(membership.role as OrgRole, requiredRole);
}

export async function getMemberCount(db: Kysely<GalleryDatabase>, orgId: string): Promise<number> {
  const result = await db
    .selectFrom('org_memberships')
    .select(db.fn.countAll<number>().as('count'))
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

export async function getOrgAppCount(db: Kysely<GalleryDatabase>, orgId: string): Promise<number> {
  const result = await db
    .selectFrom('app_listings')
    .select(db.fn.countAll<number>().as('count'))
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

export async function listOrgApps(db: Kysely<GalleryDatabase>, orgId: string) {
  return db
    .selectFrom('app_listings')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .orderBy('created_at', 'desc')
    .execute();
}
