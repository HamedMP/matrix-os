import {
  ORGANIZATION_POSITIVE_EVIDENCE_MAX_AGE_MS,
  type OrganizationMembershipProjection,
} from './organizations/projection.js';
import type { PlatformOrganizationRepository } from './organizations/repository.js';

/** Spec 537 P4: a Private Preview expires this long after it was provisioned. */
export const PRIVATE_PREVIEW_TTL_MS = 72 * 60 * 60 * 1000;

const ORGANIZATION_ID_PATTERN = /^org_[A-Za-z0-9]{1,124}$/;

/** The internal Clerk organization whose members may start Private Previews, or null when unset or invalid. */
export function parseInternalOrganizationId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && ORGANIZATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Null when the stored provisioning time cannot be parsed; the sweep treats that machine as expired. */
export function privatePreviewExpiresAt(provisionedAt: string): string | null {
  const parsed = Date.parse(provisionedAt);
  return Number.isFinite(parsed) ? new Date(parsed + PRIVATE_PREVIEW_TTL_MS).toISOString() : null;
}

/** Answers whether an actor is a current member of an organization. */
export type PrivatePreviewMembershipCheck = (organizationId: string, actorId: string) => Promise<boolean>;

/**
 * Uses the collaboration organization projection, which requires recent Clerk
 * verification and keeps the organization re-verified while it is being asked
 * about. Without a projection there is no check, and callers fail closed.
 */
export function membershipCheckFromProjection(
  projection: Pick<OrganizationMembershipProjection, 'isCurrentMember'> | undefined,
): PrivatePreviewMembershipCheck | undefined {
  return projection
    ? (organizationId, actorId) => projection.isCurrentMember({ organizationId, actorId })
    : undefined;
}

export type PrivatePreviewMembershipState = 'member' | 'not_member' | 'unknown';
export type PrivatePreviewMembershipLookup = (organizationId: string, actorId: string) => Promise<PrivatePreviewMembershipState>;

/**
 * For destructive decisions such as the sweep. Authorization treats anything
 * short of a fresh positive answer as "not a member", but destroying a machine
 * needs positive evidence: a stale or missing Clerk verification is "unknown",
 * never a lost membership. The projection call also keeps the organization
 * under re-verification.
 */
export function membershipLookupFromOrganizations(
  organizations: {
    projection: Pick<OrganizationMembershipProjection, 'isCurrentMember'>;
    repository: Pick<PlatformOrganizationRepository, 'getMembershipSnapshot'>;
  } | undefined,
  options: { now?: () => Date; maxAgeMs?: number } = {},
): PrivatePreviewMembershipLookup | undefined {
  if (!organizations) return undefined;
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? ORGANIZATION_POSITIVE_EVIDENCE_MAX_AGE_MS;
  return async (organizationId, actorId) => {
    if (await organizations.projection.isCurrentMember({ organizationId, actorId })) return 'member';
    // One statement, so a reconciliation committing between reads cannot pair a
    // fresh verification with an outdated membership row.
    const snapshot = await organizations.repository.getMembershipSnapshot({ organizationId, actorId });
    if (!snapshot?.verifiedAt || now().getTime() - snapshot.verifiedAt.getTime() > maxAgeMs) return 'unknown';
    if (snapshot.lifecycle === 'active' && snapshot.membershipState === 'active') return 'member';
    return 'not_member';
  };
}
