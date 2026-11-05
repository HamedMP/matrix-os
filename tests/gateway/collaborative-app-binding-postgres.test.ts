import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import {
  CollaborativeAppShareRepository,
  CollaborativeAppShareRepositoryError,
} from "../../packages/gateway/src/collaboration/collaborative-app-share-repository.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const catalogId = "50000000-0000-4000-8000-000000000001";
const readinessOne = "60000000-0000-4000-8000-000000000001";
const readinessTwo = "60000000-0000-4000-8000-000000000002";
const scopeOne = "70000000-0000-4000-8000-000000000001";
const scopeTwo = "70000000-0000-4000-8000-000000000002";
const now = new Date("2026-11-05T10:00:00.000Z");
const baseBuild = {
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

describe("collaborative app exact binding persistence", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborativeAppShareRepository;
  let readiness: CollaborativeAppReadinessRepository;
  let buildTwo: typeof baseBuild;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    const catalog = new CollaborationResourceCatalog(fixture.db, {
      now: () => now,
      createId: () => catalogId,
    });
    await catalog.register({
      ownerId: "user_owner",
      projectId: null,
      kind: "app",
      path: baseBuild.appId,
      incarnation: baseBuild.registrationIncarnation,
    });
    for (const scopeId of [scopeOne, scopeTwo]) {
      const scopeOwner = scopeId === scopeOne ? "user_owner" : "user_other";
      await fixture.db.insertInto("collaboration_scopes").values({
        id: scopeId,
        owner_type: "personal",
        owner_id: scopeOwner,
        organization_id: "org_matrix_team",
        kind: "app",
        resource_id: catalogId,
        parent_scope_id: null,
        membership_mode: "direct",
        lifecycle: "shared",
        revision: 1,
        auth_epoch: 1,
        authority_runtime_id: "runtime_owner",
        authority_generation: 1,
        execution_generation: null,
        execution_eligibility: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      }).execute();
    }
    const ids = [readinessOne, readinessTwo];
    readiness = new CollaborativeAppReadinessRepository(fixture.db, {
      now: () => now,
      createId: () => ids.shift()!,
    });
    await ready(baseBuild);
    buildTwo = { ...baseBuild, manifestVersion: "1.0.1", buildId: "f".repeat(64), assetDigest: "1".repeat(64) };
    repository = new CollaborativeAppShareRepository(fixture.db, { now: () => now });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.destroy();
  });

  async function ready(build: typeof baseBuild) {
    const row = await readiness.createOrGet({
      ownerId: "user_owner",
      build,
      artifactRef: `objects/${build.buildId}`,
      verifierVersion: "collaborative-app-v1",
    });
    return readiness.transition({
      id: row.id,
      ownerId: "user_owner",
      expectedRevision: 1,
      status: "ready",
      gateResults: [{ code: "two_principal_round_trip", status: "passed" }],
      verifiedAt: now,
    });
  }

  it("creates one live exact certificate binding and replays only an exact match", async () => {
    const first = await repository.create({
      scopeId: scopeOne,
      ownerId: "user_owner",
      readinessId: readinessOne,
      expectedBuildId: baseBuild.buildId,
    });
    expect(first).toMatchObject({
      scopeId: scopeOne,
      catalogId,
      readinessId: readinessOne,
      buildId: baseBuild.buildId,
      dataRevision: 0,
      state: "active",
      revision: 1,
    });
    expect(await repository.create({
      scopeId: scopeOne,
      ownerId: "user_owner",
      readinessId: readinessOne,
      expectedBuildId: baseBuild.buildId,
    })).toEqual(first);
    expect(await new CollaborativeAppShareRepository(fixture.db).create({
      scopeId: scopeOne,
      ownerId: "user_owner",
      readinessId: readinessOne,
      expectedBuildId: baseBuild.buildId,
    })).toEqual(first);
    expect(await repository.getActiveByCatalog({ ownerId: "user_owner", catalogId })).toEqual(first);
    await expect(repository.create({
      scopeId: scopeTwo,
      ownerId: "user_owner",
      readinessId: readinessOne,
      expectedBuildId: baseBuild.buildId,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.create({
      scopeId: scopeTwo,
      ownerId: "user_owner",
      readinessId: readinessOne,
      expectedBuildId: "9".repeat(64),
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("enforces data and binding revision predicates in the update statement", async () => {
    await repository.create({ scopeId: scopeOne, ownerId: "user_owner", readinessId: readinessOne, expectedBuildId: baseBuild.buildId });
    const advanced = await repository.advanceDataRevision({
      scopeId: scopeOne,
      ownerId: "user_owner",
      expectedBindingRevision: 1,
      expectedDataRevision: 0,
    });
    expect(advanced).toMatchObject({ dataRevision: 1, revision: 2 });
    await expect(repository.advanceDataRevision({
      scopeId: scopeOne,
      ownerId: "user_owner",
      expectedBindingRevision: 1,
      expectedDataRevision: 0,
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("CAS rebinds to a ready build, retains data revision, then stops without refreshing tombstones", async () => {
    await repository.create({ scopeId: scopeOne, ownerId: "user_owner", readinessId: readinessOne, expectedBuildId: baseBuild.buildId });
    await repository.advanceDataRevision({
      scopeId: scopeOne,
      ownerId: "user_owner",
      expectedBindingRevision: 1,
      expectedDataRevision: 0,
    });
    await ready(buildTwo);
    const rebound = await repository.rebind({
      scopeId: scopeOne,
      ownerId: "user_owner",
      expectedRevision: 2,
      readinessId: readinessTwo,
      expectedBuildId: buildTwo.buildId,
    });
    expect(rebound).toMatchObject({ buildId: buildTwo.buildId, readinessId: readinessTwo, dataRevision: 1, revision: 3 });
    await expect(repository.rebind({
      scopeId: scopeOne,
      ownerId: "user_owner",
      expectedRevision: 2,
      readinessId: readinessTwo,
      expectedBuildId: buildTwo.buildId,
    })).rejects.toMatchObject({ code: "conflict" });
    const stopped = await repository.stop({ scopeId: scopeOne, ownerId: "user_owner", expectedRevision: 3 });
    expect(stopped).toMatchObject({ state: "stopped", revision: 4 });
    await expect(repository.stop({ scopeId: scopeOne, ownerId: "user_owner", expectedRevision: 4 }))
      .rejects.toBeInstanceOf(CollaborativeAppShareRepositoryError);
    expect(await repository.getActiveByCatalog({ ownerId: "user_owner", catalogId })).toBeNull();
  });

  it("rejects every malformed mutation boundary before persistence", async () => {
    const createBase = { scopeId: scopeOne, ownerId: "user_owner", readinessId: readinessOne, expectedBuildId: baseBuild.buildId };
    for (const input of [
      { ...createBase, scopeId: "bad" },
      { ...createBase, ownerId: "" },
      { ...createBase, readinessId: "bad" },
      { ...createBase, expectedBuildId: "bad" },
    ]) await expect(repository.create(input)).rejects.toMatchObject({ code: "invalid" });

    const advanceBase = { scopeId: scopeOne, ownerId: "user_owner", expectedBindingRevision: 1, expectedDataRevision: 0 };
    for (const input of [
      { ...advanceBase, scopeId: "bad" },
      { ...advanceBase, ownerId: "" },
      { ...advanceBase, expectedBindingRevision: Number.NaN },
      { ...advanceBase, expectedBindingRevision: 0 },
      { ...advanceBase, expectedDataRevision: -1 },
    ]) await expect(repository.advanceDataRevision(input)).rejects.toMatchObject({ code: "invalid" });

    const rebindBase = { ...createBase, expectedRevision: 1 };
    for (const input of [
      { ...rebindBase, scopeId: "bad" },
      { ...rebindBase, ownerId: "" },
      { ...rebindBase, readinessId: "bad" },
      { ...rebindBase, expectedBuildId: "bad" },
      { ...rebindBase, expectedRevision: Number.NaN },
      { ...rebindBase, expectedRevision: 0 },
    ]) await expect(repository.rebind(input)).rejects.toMatchObject({ code: "invalid" });

    const stopBase = { scopeId: scopeOne, ownerId: "user_owner", expectedRevision: 1 };
    for (const input of [
      { ...stopBase, scopeId: "bad" },
      { ...stopBase, ownerId: "" },
      { ...stopBase, expectedRevision: Number.NaN },
      { ...stopBase, expectedRevision: 0 },
    ]) await expect(repository.stop(input)).rejects.toMatchObject({ code: "invalid" });
  });

  it("maps database constraint and availability failures to safe typed errors", async () => {
    const input = { scopeId: scopeOne, ownerId: "user_owner", readinessId: readinessOne, expectedBuildId: baseBuild.buildId };
    for (const failure of [
      { code: "23505" },
      { code: "23503" },
      { code: "23514" },
    ]) {
      const executor = vi.spyOn(fixture.db, "getExecutor").mockImplementation(() => { throw failure; });
      await expect(repository.create(input)).rejects.toMatchObject({ code: "conflict" });
      executor.mockRestore();
    }
    for (const failure of [new Error("connection lost"), "connection lost"]) {
      const executor = vi.spyOn(fixture.db, "getExecutor").mockImplementation(() => { throw failure; });
      await expect(repository.create(input)).rejects.toMatchObject({ code: "unavailable" });
      executor.mockRestore();
    }
  });
});
