import type { PlatformCollaborationComposition } from './collaboration/wiring.js';
import {
  membershipCheckFromProjection,
  membershipLookupFromOrganizations,
  parseInternalOrganizationId,
  type PrivatePreviewMembershipCheck,
  type PrivatePreviewMembershipLookup,
} from './private-preview-access.js';
import { createPrivatePreviewEligibility, type PrivatePreviewEligibility } from './private-preview-eligibility.js';

export interface PrivatePreviewAccess {
  internalOrganizationId: string | null;
  /** Authorization: only a fresh positive answer is membership. */
  isMember?: PrivatePreviewMembershipCheck;
  /** Destructive decisions: stale or unreadable membership is unknown. */
  lookupMembership?: PrivatePreviewMembershipLookup;
  /** Spec 537 P5 for machine-bearer personal account access. */
  eligibility: PrivatePreviewEligibility;
}

/** Derives every Private Preview access decision from one configuration. */
export function createPrivatePreviewAccess(options: {
  env: NodeJS.ProcessEnv;
  collaboration?: PlatformCollaborationComposition;
  membershipOverride?: PrivatePreviewMembershipCheck;
  logError: (context: string, err: unknown) => void;
}): PrivatePreviewAccess {
  const organizations = options.collaboration && 'organizations' in options.collaboration
    ? options.collaboration.organizations
    : undefined;
  const internalOrganizationId = parseInternalOrganizationId(options.env.MATRIX_INTERNAL_CLERK_ORG_ID);
  const isMember = options.membershipOverride ?? membershipCheckFromProjection(organizations?.projection);
  return {
    internalOrganizationId,
    isMember,
    lookupMembership: membershipLookupFromOrganizations(organizations),
    eligibility: createPrivatePreviewEligibility({ internalOrganizationId, isMember, logError: options.logError }),
  };
}
