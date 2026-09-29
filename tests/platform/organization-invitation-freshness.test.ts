import { describe, expect, it, vi } from "vitest";
import { createOrganizationMembershipProjection } from "../../packages/platform/src/organizations/projection.js";

const organizationId = "org_invites000000000000000";

describe("invitation admin reconciliation", () => {
  it("starts a second upstream pass after any pass already in flight", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const upstream = { listMembers: vi.fn(async () => {
      calls++;
      if (calls === 1) await firstGate;
      return { organization: { organizationId, name: "Team", slug: "team", aiSubmission: "owner_only" as const, sourceUpdatedAt: new Date() }, members: [] };
    }) };
    const repository = { reconcileOrganization: vi.fn(async () => ({ endedMemberships: [], membershipEpoch: 1 })) };
    const projection = createOrganizationMembershipProjection({ repository: repository as never, upstream });
    const prior = projection.reconcile(organizationId);
    const fresh = projection.reconcileFresh(organizationId);
    expect(upstream.listMembers).toHaveBeenCalledTimes(1);
    releaseFirst();
    expect((await prior).verified).toBe(true);
    expect((await fresh).verified).toBe(true);
    expect(upstream.listMembers).toHaveBeenCalledTimes(2);
    await projection.shutdown();
  });
});
