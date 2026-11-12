import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { CollaborativeAppShareRepository } from "../../packages/gateway/src/collaboration/collaborative-app-share-repository.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const now = new Date("2026-11-05T10:00:00.000Z");
const ownerId = "user_member_owner";
const organizationId = "org_matrix_team";
const catalogId = "50000000-0000-4000-8000-000000000001";
const readinessId = "60000000-0000-4000-8000-000000000001";
const scopeId = "70000000-0000-4000-8000-000000000001";
const build = {
  appId: "team-tracker",
  catalogId,
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};

describe("collaborative app current-membership authority", () => {
  let fixture: CollaborationTestDatabase;
  let authority: CollaborationAuthority;
  let shares: CollaborativeAppShareRepository;
  const currentMembers = new Set([ownerId, "user_member", "user_guest"]);

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await new CollaborationResourceCatalog(fixture.db, { now: () => now, createId: () => catalogId }).register({
      ownerId, projectId: null, kind: "app", path: build.appId, incarnation: build.registrationIncarnation,
    });
    const readiness = new CollaborativeAppReadinessRepository(fixture.db, { now: () => now, createId: () => readinessId });
    await readiness.createOrGet({ ownerId, build, artifactRef: `objects/${build.buildId}`, verifierVersion: "v1" });
    await readiness.transition({
      id: readinessId, ownerId, expectedRevision: 1, status: "ready",
      gateResults: [{ code: "cleanup", status: "passed" }], verifiedAt: now,
    });
    shares = new CollaborativeAppShareRepository(fixture.db, { now: () => now, createId: () => scopeId });
    await shares.createAtomic({
      ownerId, organizationId, catalogId, readinessId,
      expectedResourceRevision: 0, expectedReadinessRevision: 2, expectedBuildId: build.buildId,
      expectedBinding: null,
      clientRequestId: "80000000-0000-4000-8000-000000000001", payloadHash: "f".repeat(64), runtimeId: "runtime_owner",
    });
    authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), {
      now: () => now,
      organizationPrecondition: {
        require: async ({ actorId, organizationId: requested }) => {
          if (requested !== organizationId || !currentMembers.has(actorId)) throw new Error("not current");
          return { actorId, organizationId: requested, membershipEpoch: "epoch-1" };
        },
      } as never,
    });
  });

  afterEach(async () => {
    currentMembers.clear();
    currentMembers.add(ownerId);
    currentMembers.add("user_member");
    currentMembers.add("user_guest");
    await fixture.destroy();
  });

  it("gives every current member including guests full declared app use without recipient roles or grants", async () => {
    for (const actorId of ["user_member", "user_guest"]) {
      await expect(authority.authorize({ scopeId, actorId, action: "read" })).resolves.toMatchObject({
        actorId, ownerId, organizationId, resourceKind: "app", role: "editor", capability: "read",
      });
      await expect(authority.authorize({ scopeId, actorId, action: "mutate_resource" })).resolves.toMatchObject({
        actorId, role: "editor", capability: "mutate_resource",
      });
    }
    expect(await fixture.db.selectFrom("collaboration_members").selectAll().execute()).toEqual([
      expect.objectContaining({ actor_id: ownerId, role: "owner" }),
    ]);
    expect(await fixture.db.selectFrom("collaboration_grants").selectAll().execute()).toEqual([]);
  });

  it("denies departed members and stopped or stale exact bindings at the authorization boundary", async () => {
    currentMembers.delete("user_member");
    await expect(authority.authorize({ scopeId, actorId: "user_member", action: "read" })).rejects.toBeTruthy();
    await shares.stopAtomic({
      scopeId, ownerId, expectedScopeRevision: 1, expectedBindingRevision: 1,
      clientRequestId: "80000000-0000-4000-8000-000000000002", payloadHash: "9".repeat(64),
    });
    await expect(authority.authorize({ scopeId, actorId: "user_guest", action: "read" }))
      .rejects.toMatchObject({ code: "unavailable" });
  });
});
