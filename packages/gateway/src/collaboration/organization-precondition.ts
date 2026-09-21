/**
 * Organization precondition (S20 / T098, T100).
 *
 * Collaboration exists only inside an organization. Every authorization on
 * the home computer passes through this precondition before any allow is
 * considered: the resource's scope must record an owning organization and a
 * registered membership source must return fresh positive evidence that the
 * actor is a current member of it. With no source registered (the state
 * between S20 and the S03 membership projection) there is no positive
 * evidence and every request is denied. No release flag, milestone or
 * rollout cohort participates.
 */
import { CollaborationAuthorizationError } from "./authority-error.js";

/** Organization AI-submission policy as projected by the platform; absent metadata is owner-only. */
export type OrganizationAiSubmission = "members" | "owner_only";

export type OrganizationMembershipAssertion =
  | {
    member: true;
    expiresAt: string;
    aiSubmission: OrganizationAiSubmission;
    /** The platform projection's monotonic membership epoch (decimal string), carried on fresh and cached paths. */
    membershipEpoch: string;
  }
  | { member: false };

export interface OrganizationMembershipSource {
  /** Returns fresh evidence for one actor in one organization; never cached past its expiry. */
  assertMembership(input: { organizationId: string; actorId: string }): Promise<OrganizationMembershipAssertion>;
}

export type OrganizationPreconditionDenialReason =
  | "no_membership_source"
  | "no_organization_context"
  | "not_a_member"
  | "evidence_expired"
  | "source_failure";

/** Fresh positive evidence: the authoritative expiry of the membership assertion that satisfied the check. */
export interface OrganizationMembershipEvidence {
  expiresAt: string;
}

export interface OrganizationPrecondition {
  /** Throws a generic not-found authorization error unless fresh membership is proven; returns the evidence deadline. */
  require(input: { organizationId: string | null | undefined; actorId: string }): Promise<OrganizationMembershipEvidence>;
  /** S03 registers the Clerk membership projection here; only one source may be registered. */
  registerSource(source: OrganizationMembershipSource): void;
  describe(): { source: "none" | "registered" };
}

const DENIAL_LOG_INTERVAL_MS = 60_000;
const MAX_LOGGED_REASONS = 8;

export function createOrganizationPrecondition(options: {
  source?: OrganizationMembershipSource;
  now?: () => Date;
} = {}): OrganizationPrecondition {
  const now = options.now ?? (() => new Date());
  let source: OrganizationMembershipSource | undefined = options.source;
  const lastLogged = new Map<OrganizationPreconditionDenialReason, number>();

  const deny = (reason: OrganizationPreconditionDenialReason): never => {
    const current = now().getTime();
    const previous = lastLogged.get(reason);
    if (previous === undefined || current - previous >= DENIAL_LOG_INTERVAL_MS) {
      if (lastLogged.size >= MAX_LOGGED_REASONS && previous === undefined) lastLogged.clear();
      lastLogged.set(reason, current);
      console.warn("[collaboration-org-precondition] denied", reason);
    }
    // A missing or failing membership source is a missing server dependency: it surfaces as a
    // generic unavailable (503-style) denial, never as not-found and never as an allow. Every
    // other reason is an ordinary generic denial.
    if (reason === "no_membership_source" || reason === "source_failure") {
      throw new CollaborationAuthorizationError("unavailable", "Collaboration unavailable");
    }
    throw new CollaborationAuthorizationError("not_found", "Current membership is required");
  };

  return {
    async require(input) {
      if (!source) return deny("no_membership_source");
      const organizationId = input.organizationId;
      if (!organizationId) return deny("no_organization_context");
      let assertion: OrganizationMembershipAssertion | undefined;
      try {
        assertion = await source.assertMembership({ organizationId, actorId: input.actorId });
      } catch (error: unknown) {
        console.warn("[collaboration-org-precondition] membership source failed",
          error instanceof Error ? error.name : "UnknownError");
      }
      if (!assertion) return deny("source_failure");
      if (!assertion.member) return deny("not_a_member");
      const expiresAt = Date.parse(assertion.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now().getTime()) return deny("evidence_expired");
      return { expiresAt: new Date(expiresAt).toISOString() };
    },
    registerSource(next) {
      if (source) throw new Error("Organization membership source is already registered");
      source = next;
    },
    describe() {
      return { source: source ? "registered" : "none" };
    },
  };
}
