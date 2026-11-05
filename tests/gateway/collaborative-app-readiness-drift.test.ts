import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const catalogId = "50000000-0000-4000-8000-000000000001";
const readinessId = "60000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-05T10:00:00.000Z");
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

describe("collaborative app readiness drift", () => {
  let fixture: CollaborationTestDatabase;
  let catalog: CollaborationResourceCatalog;
  let readiness: CollaborativeAppReadinessRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    catalog = new CollaborationResourceCatalog(fixture.db, { now: () => now, createId: () => catalogId });
    await catalog.register({
      ownerId: "user_owner",
      projectId: null,
      kind: "app",
      path: build.appId,
      incarnation: build.registrationIncarnation,
    });
    readiness = new CollaborativeAppReadinessRepository(fixture.db, {
      now: () => now,
      createId: () => readinessId,
    });
    const row = await readiness.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: `objects/${build.buildId}`,
      verifierVersion: "collaborative-app-v1",
    });
    await readiness.transition({
      id: row.id,
      ownerId: "user_owner",
      expectedRevision: 1,
      status: "ready",
      gateResults: [{ code: "cleanup", status: "passed" }],
      verifiedAt: now,
    });
  });

  afterEach(async () => fixture.destroy());

  it("stales old exact-build certificates but preserves the current build across ordinary restart", async () => {
    expect(await readiness.invalidateDriftedBuilds({
      ownerId: "user_owner",
      catalogId,
      currentBuildId: build.buildId,
    })).toBe(0);
    expect((await readiness.get({ id: readinessId, ownerId: "user_owner" }))?.status).toBe("ready");
    expect(await readiness.invalidateDriftedBuilds({
      ownerId: "user_owner",
      catalogId,
      currentBuildId: "f".repeat(64),
    })).toBe(1);
    expect(await readiness.get({ id: readinessId, ownerId: "user_owner" })).toMatchObject({
      status: "stale",
      invalidationReason: "build_drift",
    });
    for (const invalid of [
      { ownerId: "bad owner", catalogId, currentBuildId: build.buildId },
      { ownerId: "user_owner", catalogId: "bad-id", currentBuildId: build.buildId },
      { ownerId: "user_owner", catalogId, currentBuildId: "bad-digest" },
    ]) {
      await expect(readiness.invalidateDriftedBuilds(invalid)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("invalidates readiness transactionally on registration replacement and catalog deletion", async () => {
    await catalog.bump(fixture.db, {
      id: catalogId,
      expectedRevision: 0,
      incarnation: "f".repeat(64),
    });
    expect(await readiness.get({ id: readinessId, ownerId: "user_owner" })).toMatchObject({
      status: "stale",
      invalidationReason: "build_drift",
    });

    const replacementId = "60000000-0000-4000-8000-000000000002";
    await fixture.db.updateTable("collaboration_app_readiness").set({
      id: replacementId,
      status: "ready",
      registration_incarnation: "f".repeat(64),
      verified_at: now,
      invalidated_at: null,
      invalidation_reason: null,
    }).where("id", "=", readinessId).execute();
    await catalog.remove({ id: catalogId, expectedRevision: 1 });
    const row = await fixture.db.selectFrom("collaboration_app_readiness").selectAll()
      .where("id", "=", replacementId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "stale", invalidation_reason: "catalog_deleted" });
  });
});
