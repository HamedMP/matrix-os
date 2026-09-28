import type { Kysely } from 'kysely';
import type { PlatformDB } from './db.js';
import type { OrganizationPlatformDatabase } from './organizations/database.js';

/** Spec 537 P4: a Private Preview expires this long after it was provisioned. */
export const PRIVATE_PREVIEW_TTL_MS = 72 * 60 * 60 * 1000;

const ORGANIZATION_ID_PATTERN = /^org_[A-Za-z0-9]{1,124}$/;

/** The internal Clerk organization whose members may start Private Previews, or null when unset or invalid. */
export function parseInternalOrganizationId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && ORGANIZATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function privatePreviewExpiresAt(provisionedAt: string): string {
  return new Date(Date.parse(provisionedAt) + PRIVATE_PREVIEW_TTL_MS).toISOString();
}

/**
 * Reads the platform's Clerk organization projection: the actor holds an
 * active membership in an active organization. Throws when the projection is
 * unavailable, so callers fail closed rather than treating it as non-membership.
 */
export async function isActiveOrganizationMember(
  db: PlatformDB,
  organizationId: string,
  actorId: string,
): Promise<boolean> {
  await db.ready;
  const organizations = db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
  const row = await organizations
    .selectFrom('organization_memberships as m')
    .innerJoin('organizations as o', 'o.organization_id', 'm.organization_id')
    .select('m.actor_id')
    .where('m.organization_id', '=', organizationId)
    .where('m.actor_id', '=', actorId)
    .where('m.state', '=', 'active')
    .where('o.lifecycle', '=', 'active')
    .executeTakeFirst();
  return row !== undefined;
}
