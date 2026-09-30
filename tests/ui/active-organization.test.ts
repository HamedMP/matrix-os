import { describe, expect, it } from "vitest";
import {
  OrganizationListingSchema,
  resolveActiveOrganizationId,
  type OrganizationMemberships,
} from "../../packages/ui/src/organizations/active-organization.js";

function loaded(organizations: Array<{ organizationId: string; state?: string }>): OrganizationMemberships {
  return { status: "loaded", listing: OrganizationListingSchema.parse({ organizations }) };
}

describe("resolveActiveOrganizationId", () => {
  it("uses Clerk's active organization whatever the membership listing says", () => {
    expect(resolveActiveOrganizationId({ clerkOrganizationId: "org_alpha", memberships: { status: "loading" } })).toBe("org_alpha");
    expect(resolveActiveOrganizationId({ clerkOrganizationId: "org_alpha", memberships: { status: "failed" } })).toBe("org_alpha");
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: "org_alpha",
      memberships: loaded([{ organizationId: "org_beta" }]),
    })).toBe("org_alpha");
  });

  it("uses the only verified membership when Clerk has no active organization", () => {
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: null,
      memberships: loaded([{ organizationId: "org_alpha" }]),
    })).toBe("org_alpha");
    // A repeated entry is still one membership.
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: null,
      memberships: loaded([{ organizationId: "org_alpha" }, { organizationId: "org_alpha" }]),
    })).toBe("org_alpha");
  });

  it("yields none for zero or several verified memberships rather than guessing", () => {
    expect(resolveActiveOrganizationId({ clerkOrganizationId: null, memberships: loaded([]) })).toBeNull();
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: null,
      memberships: loaded([{ organizationId: "org_alpha" }, { organizationId: "org_beta" }]),
    })).toBeNull();
  });

  it("counts only verified memberships, never organizations still being set up", () => {
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: null,
      memberships: loaded([{ organizationId: "org_alpha", state: "listed" }, { organizationId: "org_beta", state: "setting_up" }]),
    })).toBe("org_alpha");
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: null,
      memberships: loaded([{ organizationId: "org_beta", state: "setting_up" }]),
    })).toBeNull();
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: null,
      memberships: loaded([{ organizationId: "org_beta", state: "unknown_future_state" }]),
    })).toBeNull();
  });

  it("yields none while Clerk or the listing is loading, and when the listing failed", () => {
    expect(resolveActiveOrganizationId({
      clerkOrganizationId: undefined,
      memberships: loaded([{ organizationId: "org_alpha" }]),
    })).toBeNull();
    expect(resolveActiveOrganizationId({ clerkOrganizationId: null, memberships: { status: "loading" } })).toBeNull();
    expect(resolveActiveOrganizationId({ clerkOrganizationId: null, memberships: { status: "failed" } })).toBeNull();
  });

  it("yields none for a malformed Clerk organization identifier", () => {
    expect(resolveActiveOrganizationId({ clerkOrganizationId: "not-an-org", memberships: loaded([{ organizationId: "org_alpha" }]) })).toBeNull();
    expect(resolveActiveOrganizationId({ clerkOrganizationId: "", memberships: loaded([{ organizationId: "org_alpha" }]) })).toBeNull();
  });
});

describe("OrganizationListingSchema", () => {
  it("accepts the platform listing and tolerates additional fields", () => {
    const listing = OrganizationListingSchema.parse({
      organizations: [{ organizationId: "org_alpha", name: "Alpha", role: "member", membershipEpoch: 3 }],
      nextCursor: "ignored",
    });
    expect(listing.organizations.map((entry) => entry.organizationId)).toEqual(["org_alpha"]);
  });

  it("rejects malformed identifiers and listings above the platform cap", () => {
    expect(OrganizationListingSchema.safeParse({ organizations: [{ organizationId: "user_alpha" }] }).success).toBe(false);
    expect(OrganizationListingSchema.safeParse({ organizations: [{}] }).success).toBe(false);
    expect(OrganizationListingSchema.safeParse({}).success).toBe(false);
    const oversized = Array.from({ length: 101 }, (_, index) => ({ organizationId: `org_${index}` }));
    expect(OrganizationListingSchema.safeParse({ organizations: oversized }).success).toBe(false);
  });
});
