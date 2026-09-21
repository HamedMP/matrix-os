import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createOrganizationMembershipProjection, type ClerkOrganizationUpstream } from "../../packages/platform/src/organizations/projection.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const org = "org_2proj00000000000000000001";
const other = "org_2proj00000000000000000002";
const member = "user_member0000000000000000";
const outsider = "user_outsider00000000000000";

function snapshot(organizationId: string, members: string[], updatedAt = 1_000) {
  return {
    organization: { organizationId, name: "Org", slug: "org", aiSubmission: "members" as const, sourceUpdatedAt: new Date(updatedAt) },
    members: members.map((actorId) => ({ membershipId: `orgmem_${actorId}`, actorId, role: "org:member", sourceUpdatedAt: new Date(updatedAt) })),
  };
}

describe("organization membership projection (T016/T019)", () => {
  let fixture: TestPlatformDb;
  let db: Kysely<OrganizationPlatformDatabase>;
  let repository: PlatformOrganizationRepository;
  let clock: Date;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    db = fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(db);
    repository = new PlatformOrganizationRepository(db, { now: () => clock });
    clock = new Date("2026-09-20T12:00:00.000Z");
  });

  afterEach(async () => destroyTestPlatformDb(fixture.db));

  it("anchors evidence expiry to the upstream request start and never to receipt time", async () => {
    const upstream: ClerkOrganizationUpstream = { listMembers: async () => snapshot(org, [member]) };
    const projection = createOrganizationMembershipProjection({ repository, upstream, now: () => clock });
    await projection.reconcile(org);
    const started = new Date(clock.getTime() - 4_000);
    const assertion = await projection.assert({ organizationId: org, actorId: member, requestStartedAt: started });
    expect(assertion).toMatchObject({ member: true, aiSubmission: "members", requestStartedAt: started });
    expect(assertion.expiresAt.getTime()).toBe(started.getTime() + 20_000);
    expect((await projection.assert({ organizationId: org, actorId: outsider, requestStartedAt: started })).member).toBe(false);
    expect((await projection.assert({ organizationId: other, actorId: member, requestStartedAt: started })).member).toBe(false);
    await projection.shutdown();
  });

  it("coalesces concurrent reconciliations of one organization into a single upstream call", async () => {
    const listMembers = vi.fn(async () => snapshot(org, [member]));
    const projection = createOrganizationMembershipProjection({ repository, upstream: { listMembers }, now: () => clock });
    await Promise.all([projection.reconcile(org), projection.reconcile(org), projection.reconcile(org)]);
    expect(listMembers).toHaveBeenCalledTimes(1);
    await projection.shutdown();
  });

  it("tombstones members missing from the upstream snapshot and reports them as ended", async () => {
    let members = [member, outsider];
    const projection = createOrganizationMembershipProjection({ repository, upstream: { listMembers: async () => snapshot(org, members, 2_000) }, now: () => clock });
    await projection.reconcile(org);
    members = [member];
    const result = await projection.reconcile(org);
    expect(result.endedMemberships).toEqual([{ organizationId: org, actorId: outsider }]);
    expect((await repository.getMembership({ organizationId: org, actorId: outsider }))?.state).toBe("removed");
    expect(await repository.describeRevocationIntents({ organizationId: org, actorId: outsider })).toMatchObject([{ denialId: null, deadLetter: false }]);
    await projection.shutdown();
  });

  it("refreshes only recently active organizations on the recurring timer, bounded and LRU-evicted", async () => {
    vi.useFakeTimers();
    try {
      const listMembers = vi.fn(async (organizationId: string) => snapshot(organizationId, [member]));
      const projection = createOrganizationMembershipProjection({
        repository, upstream: { listMembers }, now: () => clock, refreshIntervalMs: 10_000, maxTrackedOrganizations: 2, startTimers: true,
      });
      projection.touch(org);
      projection.touch(other);
      projection.touch("org_2proj00000000000000000003");
      await vi.advanceTimersByTimeAsync(10_000);
      const called = listMembers.mock.calls.map((call) => call[0]).sort();
      expect(called).toEqual([other, "org_2proj00000000000000000003"]);
      await projection.shutdown();
      listMembers.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(listMembers).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers isCurrentMember for the identifier resolver with the same freshness rule", async () => {
    const projection = createOrganizationMembershipProjection({ repository, upstream: { listMembers: async () => snapshot(org, [member]) }, now: () => clock });
    expect(await projection.isCurrentMember({ organizationId: org, actorId: member })).toBe(false);
    await projection.reconcile(org);
    expect(await projection.isCurrentMember({ organizationId: org, actorId: member })).toBe(true);
    expect(await projection.isCurrentMember({ organizationId: org, actorId: outsider })).toBe(false);
    await projection.shutdown();
  });

  it("denies everything when no upstream is configured", async () => {
    const projection = createOrganizationMembershipProjection({ repository, now: () => clock });
    await repository.applyOrganization({ organizationId: org, name: "Org", slug: "org", aiSubmission: "owner_only", sourceUpdatedAt: new Date(1) });
    await repository.applyMembership({ organizationId: org, membershipId: "orgmem_x", actorId: member, role: "org:member", sourceUpdatedAt: new Date(1), state: "active" });
    await expect(projection.reconcile(org)).resolves.toMatchObject({ verified: false });
    expect(await projection.assert({ organizationId: org, actorId: member, requestStartedAt: clock })).toMatchObject({ member: false, aiSubmission: "owner_only" });
    await projection.shutdown();
  });
});
