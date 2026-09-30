import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { OrganizationAdminRepository } from "../../packages/platform/src/organizations/admin-repository.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const organizationId = "org_invites000000000000000";
const actorId = "user_admin000000000000000";
const firstRequestId = "a77b8e1c-6112-4250-93d8-650d6fca8174";
const nextRequestId = "a77b8e1c-6112-4250-93d8-650d6fca8175";
const firstInvitationId = "orginv_first000000000000000";

describe("invitation claim identity", () => {
  let fixture: TestPlatformDb;
  let repository: OrganizationAdminRepository;
  let clock: Date;
  const input = (role: "org:admin" | "org:member", clientRequestId = firstRequestId) => ({
    organizationId, actorId, addressDigest: "a".repeat(64), clientRequestId, role,
  });
  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    await bootstrapPlatformOrganizationDatabase(fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new OrganizationAdminRepository(fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>, { now: () => clock });
  });
  afterEach(async () => destroyTestPlatformDb(fixture.db));

  it("refuses to reuse an admin invitation as a member invitation", async () => {
    const first = await repository.beginInvitation(input("org:admin"));
    await repository.completeInvitation(first.record, firstInvitationId, new Date(clock.getTime() + 60_000));
    await expect(repository.beginInvitation(input("org:member", nextRequestId))).rejects.toThrow();
    expect((await repository.getInvitation(organizationId, input("org:admin").addressDigest))?.role).toBe("org:admin");
  });

  it("uses a fresh webhook marker for each reclaimed claim and ignores a delayed old terminal event", async () => {
    const first = await repository.beginInvitation(input("org:member"));
    const oldMarker = first.record.attemptRequestId;
    clock = new Date(clock.getTime() + 2 * 60_000);
    const replacement = await repository.beginInvitation(input("org:member", nextRequestId));
    expect(replacement.claimed).toBe(true);
    expect(replacement.reclaim).toBe(true);
    expect(replacement.record.attemptRequestId).not.toBe(oldMarker);
    await repository.deleteInvitationTerminal(organizationId, firstInvitationId, oldMarker);
    expect(await repository.getInvitation(organizationId, input("org:member").addressDigest)).not.toBeNull();
    await repository.deleteInvitationTerminal(organizationId, firstInvitationId, replacement.record.attemptRequestId);
    expect(await repository.getInvitation(organizationId, input("org:member").addressDigest)).toBeNull();
  });
});
