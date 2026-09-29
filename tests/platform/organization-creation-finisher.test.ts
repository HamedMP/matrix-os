import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { OrganizationAdminRepository } from "../../packages/platform/src/organizations/admin-repository.js";
import { OrganizationCreationFinisher } from "../../packages/platform/src/organizations/creation-finisher.js";
import type { ClerkOrganizationAdmin, OrganizationMarkerLookup } from "../../packages/platform/src/organizations/clerk-admin-client.js";
import type { OrganizationMembershipProjection } from "../../packages/platform/src/organizations/projection.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const actorId = "user_creator000000000000000";
const requestId = "a77b8e1c-6112-4250-93d8-650d6fca8174";
const organizationId = "org_created0000000000000000";

describe("organization creation finisher", () => {
  let fixture: TestPlatformDb;
  let repository: OrganizationAdminRepository;
  let clock: Date;
  let lookup: OrganizationMarkerLookup;
  let verified: boolean;
  let clerk: ClerkOrganizationAdmin;
  let finisher: OrganizationCreationFinisher;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    await bootstrapPlatformOrganizationDatabase(fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new OrganizationAdminRepository(fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>, { now: () => clock });
    lookup = { kind: "absent" };
    verified = true;
    clerk = {
      createOrganization: vi.fn(async () => ({ organizationId })),
      findCreatedOrganization: vi.fn(async () => lookup),
    };
    const projection = {
      reconcile: vi.fn(async () => ({ verified, endedMemberships: [] })),
      isCurrentMember: vi.fn(async () => verified),
    } as unknown as OrganizationMembershipProjection;
    finisher = new OrganizationCreationFinisher({ repository, clerk, projection, now: () => clock });
  });
  afterEach(async () => { await finisher.shutdown(); await destroyTestPlatformDb(fixture.db); });

  it("adopts a lost Clerk response by exact private marker without another create", async () => {
    await repository.beginCreate(actorId, requestId, "Same name");
    clock = new Date(clock.getTime() + 2 * 60_000);
    lookup = { kind: "found", organizationId };
    await finisher.runOnce();
    expect(clerk.createOrganization).not.toHaveBeenCalled();
    expect((await repository.getRequest(actorId, requestId))?.state).toBe("listed");
  });

  it("retries a created organization after the first reconciliation fails", async () => {
    const { request } = await repository.beginCreate(actorId, requestId, "A team");
    await repository.markCreated(request, organizationId);
    verified = false;
    await finisher.runOnce();
    expect((await repository.getRequest(actorId, requestId))?.state).toBe("created");
    clock = new Date(clock.getTime() + 10_000);
    verified = true;
    await finisher.runOnce();
    expect((await repository.getRequest(actorId, requestId))?.state).toBe("listed");
  });

  it("never creates after an inconclusive lookup and flags it after ten minutes", async () => {
    await repository.beginCreate(actorId, requestId, "A team");
    lookup = { kind: "inconclusive" };
    clock = new Date(clock.getTime() + 2 * 60_000);
    await finisher.runOnce();
    expect(clerk.createOrganization).not.toHaveBeenCalled();
    clock = new Date(clock.getTime() + 8 * 60_000);
    await finisher.runOnce();
    expect((await repository.getRequest(actorId, requestId))?.state).toBe("needs_review");
    expect(clerk.createOrganization).not.toHaveBeenCalled();
  });

  it("retries create only after the two-minute settle and a complete empty lookup", async () => {
    await repository.beginCreate(actorId, requestId, "A team");
    await finisher.runOnce();
    expect(clerk.findCreatedOrganization).not.toHaveBeenCalled();
    expect(clerk.createOrganization).not.toHaveBeenCalled();
    clock = new Date(clock.getTime() + 2 * 60_000);
    await finisher.runOnce();
    expect(clerk.createOrganization).toHaveBeenCalledTimes(1);
    expect((await repository.getRequest(actorId, requestId))?.state).toBe("listed");
  });

  it("raises an unresolved pending create for review when Clerk stays unconfigured", async () => {
    await repository.beginCreate(actorId, requestId, "A team");
    clock = new Date(clock.getTime() + 10 * 60_000);
    const unavailable = new OrganizationCreationFinisher({
      repository,
      projection: { reconcile: vi.fn(), isCurrentMember: vi.fn() } as unknown as OrganizationMembershipProjection,
      now: () => clock,
    });
    await unavailable.runOnce();
    expect((await repository.getRequest(actorId, requestId))?.state).toBe("needs_review");
    await unavailable.shutdown();
  });

  it("claims only the four requests it can process concurrently", async () => {
    for (let index = 0; index < 5; index++) {
      await repository.beginCreate(`${actorId}${index}`, requestId, `Team ${index}`);
    }
    clock = new Date(clock.getTime() + 2 * 60_000);
    const claim = vi.spyOn(repository, "claimDue");
    await finisher.runOnce();
    expect(claim).toHaveBeenCalledWith(4);
    expect(clerk.createOrganization).toHaveBeenCalledTimes(4);
    expect((await repository.getRequest(`${actorId}4`, requestId))?.state).toBe("pending");
  });
});
