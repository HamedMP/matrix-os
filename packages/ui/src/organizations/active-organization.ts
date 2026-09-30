// Active organization for Share controls on every OS view (spec 535 FR-024).
// Until an in-product organization switch exists, only an unambiguous
// organization is active: picking one of several memberships could share a
// resource with the wrong organization. Web and Native Mobile read Clerk's
// active organization first; Electron has no Clerk session and relies on the
// platform membership listing alone.
import { CollaborationOrganizationIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

// Mirrors the platform's per-actor listing cap.
const MAX_LISTED_ORGANIZATIONS = 100;

/**
 * `GET /api/organizations`. An entry is a verified membership unless it
 * carries a `state` other than `listed` (an organization still being set up
 * cannot be shared into yet).
 */
export const OrganizationListingSchema = z.looseObject({
  organizations: z.array(z.looseObject({
    organizationId: CollaborationOrganizationIdSchema,
    state: z.string().max(64).optional(),
  })).max(MAX_LISTED_ORGANIZATIONS),
});

export type OrganizationListing = z.infer<typeof OrganizationListingSchema>;

export type OrganizationMemberships =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; listing: OrganizationListing };

/**
 * Returns the organization Share controls act in, or null when there is none:
 * Clerk's active organization when one is set, otherwise the account's only
 * verified membership. Loading and failure yield none, never a guess.
 */
export function resolveActiveOrganizationId(input: {
  /** Clerk's active organization: `undefined` while Clerk loads, `null` when none is active. */
  clerkOrganizationId: string | null | undefined;
  memberships: OrganizationMemberships;
}): string | null {
  const { clerkOrganizationId, memberships } = input;
  if (clerkOrganizationId === undefined) return null;
  if (clerkOrganizationId !== null) {
    return CollaborationOrganizationIdSchema.safeParse(clerkOrganizationId).success ? clerkOrganizationId : null;
  }
  if (memberships.status !== "loaded") return null;
  const verified = new Set(memberships.listing.organizations
    .filter((entry) => entry.state === undefined || entry.state === "listed")
    .map((entry) => entry.organizationId));
  return verified.size === 1 ? [...verified][0]! : null;
}
