import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  CollaborativeAppReadinessRepository,
  CollaborativeAppReadinessRepositoryError,
} from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";

import {
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

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

describe("collaborative app readiness persistence", () => {
  let fixture: CollaborationTestDatabase;
  let catalog: CollaborationResourceCatalog;
  let repository: CollaborativeAppReadinessRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    catalog = new CollaborationResourceCatalog(fixture.db, {
      now: () => now,
      createId: () => catalogId,
    });
    await catalog.register({
      ownerId: "user_owner",
      projectId: null,
      kind: "app",
      path: build.appId,
      incarnation: build.registrationIncarnation,
    });
    repository = new CollaborativeAppReadinessRepository(fixture.db, {
      now: () => now,
      createId: () => readinessId,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.destroy();
  });

  it("creates one row per exact build/verifier with ON CONFLICT replay", async () => {
    const input = {
      ownerId: "user_owner",
      build,
      artifactRef: "objects/team-tracker-build",
      verifierVersion: "collaborative-app-v1",
    };
    const first = await repository.createOrGet(input);
    const replay = await repository.createOrGet({ ...input, artifactRef: "objects/ignored-on-replay" });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      id: readinessId,
      ownerId: "user_owner",
      status: "checking",
      revision: 1,
      gateResults: [],
    });
    expect(await fixture.db.selectFrom("collaboration_app_readiness").select("id").execute()).toHaveLength(1);
  });

  it("returns the current build result after an older build is invalidated later", async () => {
    await repository.createOrGet({ ownerId: "user_owner", build,
      artifactRef: "objects/old-build", verifierVersion: "collaborative-app-v1" });
    const currentBuild = { ...build, buildId: "f".repeat(64) };
    const currentId = "60000000-0000-4000-8000-000000000002";
    const current = new CollaborativeAppReadinessRepository(fixture.db, {
      now: () => new Date("2026-11-05T10:01:00.000Z"), createId: () => currentId,
    });
    await current.createOrGet({ ownerId: "user_owner", build: currentBuild,
      artifactRef: "objects/current-build", verifierVersion: "collaborative-app-v1" });
    await current.transition({ id: currentId, ownerId: "user_owner", expectedRevision: 1,
      status: "ready", gateResults: [{ code: "declaration", status: "passed" }],
      verifiedAt: new Date("2026-11-05T10:01:00.000Z") });
    const late = new CollaborativeAppReadinessRepository(fixture.db, {
      now: () => new Date("2026-11-05T10:02:00.000Z"),
    });
    await late.invalidateDriftedBuilds({ ownerId: "user_owner", catalogId,
      currentBuildId: currentBuild.buildId });

    expect(await current.getCurrent({ ownerId: "user_owner", catalogId,
      buildId: currentBuild.buildId })).toMatchObject({ id: currentId, status: "ready" });
  });

  it("enforces CAS transitions and ready/stale state constraints", async () => {
    await repository.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: "objects/team-tracker-build",
      verifierVersion: "collaborative-app-v1",
    });
    const gates = [
      { code: "declaration" as const, status: "passed" as const },
      { code: "recipient_launch" as const, status: "passed" as const },
    ];
    const ready = await repository.transition({
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: 1,
      status: "ready",
      gateResults: gates,
      verifiedAt: now,
    });
    expect(ready).toMatchObject({ status: "ready", revision: 2, verifiedAt: now.toISOString() });
    await expect(repository.transition({
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: 1,
      status: "stale",
      gateResults: gates,
      invalidatedAt: now,
      invalidationReason: "build_drift",
    })).rejects.toMatchObject({ code: "conflict" });
    const stale = await repository.transition({
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: 2,
      status: "stale",
      gateResults: gates,
      verifiedAt: now,
      invalidatedAt: now,
      invalidationReason: "build_drift",
    });
    expect(stale).toMatchObject({ status: "stale", revision: 3, invalidationReason: "build_drift" });

    const restarted = await repository.restart({
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: 3,
    });
    expect(restarted).toMatchObject({
      status: "checking",
      revision: 4,
      gateResults: [],
      verifiedAt: null,
      invalidatedAt: null,
      invalidationReason: null,
    });
    await expect(repository.restart({
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: 3,
    })).rejects.toMatchObject({ code: "conflict" });

    await expect(sql`
      UPDATE collaboration_app_readiness
      SET status = 'ready', verified_at = NULL, invalidated_at = NULL, invalidation_reason = NULL
      WHERE id = ${readinessId}
    `.execute(fixture.db)).rejects.toThrow();
  });

  it("restarts a failed exact-build attempt without creating another row", async () => {
    await repository.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: "objects/team-tracker-build",
      verifierVersion: "collaborative-app-v1",
    });
    const failed = await repository.transition({
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: 1,
      status: "failed",
      gateResults: [{ code: "cleanup", status: "failed", action: "Try again." }],
    });
    await expect(repository.restart({
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: failed.revision,
    })).resolves.toMatchObject({ status: "checking", revision: 3 });
    expect(await fixture.db.selectFrom("collaboration_app_readiness").select("id").execute()).toHaveLength(1);
  });

  it("filters tombstoned catalog entries from normal reads", async () => {
    await repository.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: "objects/team-tracker-build",
      verifierVersion: "collaborative-app-v1",
    });
    expect(await repository.getCurrent({ ownerId: "user_owner", catalogId, buildId: build.buildId })).not.toBeNull();
    await catalog.remove({ id: catalogId, expectedRevision: 0 });
    expect(await repository.getCurrent({ ownerId: "user_owner", catalogId, buildId: build.buildId })).toBeNull();
    expect(await repository.get({ id: readinessId, ownerId: "user_owner" })).toBeNull();
  });

  it("returns typed safe failures for invalid owners and gate payloads", async () => {
    await expect(repository.createOrGet({
      ownerId: "user_other",
      build,
      artifactRef: "objects/team-tracker-build",
      verifierVersion: "collaborative-app-v1",
    })).rejects.toBeInstanceOf(CollaborativeAppReadinessRepositoryError);
    await expect(repository.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: "/home/matrix/private/build",
      verifierVersion: "collaborative-app-v1",
    })).rejects.toMatchObject({ code: "invalid" });

    for (const input of [
      { ownerId: "", build, artifactRef: "objects/build", verifierVersion: "v1" },
      { ownerId: "user_owner", build: { ...build, buildId: "bad" }, artifactRef: "objects/build", verifierVersion: "v1" },
      { ownerId: "user_owner", build, artifactRef: "../build", verifierVersion: "v1" },
      { ownerId: "user_owner", build, artifactRef: "objects/build", verifierVersion: "" },
    ]) {
      await expect(repository.createOrGet(input as never)).rejects.toMatchObject({ code: "invalid" });
    }

    const transitionBase = {
      id: readinessId,
      ownerId: "user_owner",
      expectedRevision: 1,
      status: "checking" as const,
      gateResults: [],
    };
    for (const input of [
      { ...transitionBase, id: "bad" },
      { ...transitionBase, ownerId: "" },
      { ...transitionBase, gateResults: "bad" },
      { ...transitionBase, expectedRevision: Number.NaN },
      { ...transitionBase, expectedRevision: 0 },
      { ...transitionBase, status: "ready", gateResults: [{ code: "cleanup", status: "passed" }] },
      { ...transitionBase, status: "blocked", gateResults: [{ code: "cleanup", status: "passed" }] },
      { ...transitionBase, status: "failed", gateResults: [{ code: "cleanup", status: "passed" }] },
      { ...transitionBase, status: "stale" },
      { ...transitionBase, invalidatedAt: now },
      { ...transitionBase, invalidationReason: "manual_recheck" },
    ]) {
      await expect(repository.transition(input as never)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("returns typed conflict when an inserted readiness cannot be reread", async () => {
    const original = fixture.db.selectFrom.bind(fixture.db);
    let calls = 0;
    vi.spyOn(fixture.db, "selectFrom").mockImplementation(((table: never) => {
      calls += 1;
      if (calls !== 2) return original(table);
      const missing = {
        selectAll: () => missing,
        where: () => missing,
        executeTakeFirst: async () => undefined,
      };
      return missing as never;
    }) as never);
    await expect(repository.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: "objects/build",
      verifierVersion: "v1",
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("supports default clock and id generation while preserving owner-scoped reads", async () => {
    const defaults = new CollaborativeAppReadinessRepository(fixture.db);
    const created = await defaults.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: "objects/default-build",
      verifierVersion: "default-v1",
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await defaults.get({ id: created.id, ownerId: "user_owner" })).toEqual(created);
    expect(await defaults.get({ id: created.id, ownerId: "user_other" })).toBeNull();
  });
});
