import { describe, expect, it, vi } from "vitest";

import { CollaborativeAppShareService } from "../../packages/gateway/src/collaboration/collaborative-app-share-service.js";

const NOW = new Date("2026-11-05T10:00:00.000Z");
const ownerId = "user_owner";
const organizationId = "org_matrix_team";
const readinessId = "60000000-0000-4000-8000-000000000001";
const scopeId = "70000000-0000-4000-8000-000000000001";
const build = {
  appId: "team-tracker",
  catalogId: "50000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};
const readiness = {
  id: readinessId,
  ownerId,
  build,
  artifactRef: `objects/${build.buildId}`,
  status: "ready" as const,
  gateResults: [{ code: "cleanup" as const, status: "passed" as const }],
  verifiedAt: NOW.toISOString(),
  invalidatedAt: null,
  invalidationReason: null,
  verifierVersion: "v1",
  revision: 2,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};
const binding = {
  scopeId,
  catalogId: build.catalogId,
  registrationIncarnation: build.registrationIncarnation,
  readinessId,
  buildId: build.buildId,
  dataRevision: 0,
  state: "active" as const,
  revision: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  stoppedAt: null,
};
const storedShare = {
  scopeId,
  organizationId,
  scopeRevision: 1,
  authEpoch: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  binding,
};

function setup(overrides: {
  now?: Date;
  existing?: typeof storedShare | null;
  createReplay?: typeof storedShare | null;
  readiness?: Omit<typeof readiness, "status"> & { status: "ready" | "blocked" };
} = {}) {
  const current = { build, artifactRef: `objects/${build.buildId}` };
  const catalog = { id: build.catalogId, ownerId, projectId: null, kind: "app" as const,
    path: build.appId, parentId: null, incarnation: build.registrationIncarnation,
    revision: 0, updatedAt: NOW.toISOString(), deletedAt: null };
  const shares = {
    getByCatalog: vi.fn(async () => overrides.existing ?? null),
    getCreateReplay: vi.fn(async () => overrides.createReplay ?? null),
    createAtomic: vi.fn(async () => storedShare),
    stopAtomic: vi.fn(async () => ({
      ...storedShare,
      didStop: true,
      scopeRevision: 2,
      updatedAt: (overrides.now ?? NOW).toISOString(),
      binding: { ...binding, state: "stopped" as const, revision: 2,
        updatedAt: (overrides.now ?? NOW).toISOString(), stoppedAt: (overrides.now ?? NOW).toISOString() },
    })),
  };
  const onStopped = vi.fn(async () => undefined);
  const resolveCurrentBuild = vi.fn(async () => current);
  const readinessRepository = {
    getCurrent: vi.fn(async () => overrides.readiness ?? readiness),
    get: vi.fn(async () => overrides.readiness ?? readiness),
  };
  const service = new CollaborativeAppShareService({
    ownerId,
    runtimeId: "runtime_owner",
    preflightSecret: "s".repeat(32),
    catalog: {
      get: vi.fn(async () => catalog),
      getLiveByPath: vi.fn(async () => catalog),
    },
    readiness: readinessRepository,
    shares,
    resolveCurrentBuild,
    resolveOwner: vi.fn(async () => ({ actorId: ownerId, displayName: "Owner" })),
    onStopped,
    now: () => overrides.now ?? NOW,
  });
  return { service, shares, onStopped, resolveCurrentBuild, readinessRepository };
}

describe("CollaborativeAppShareService", () => {
  it("binds a short-lived confirmation to the exact ready build and atomically creates one share", async () => {
    const { service, shares, readinessRepository } = setup();
    const preflight = await service.preflight(ownerId, build.appId, {
      organizationId,
      expectedReadinessRevision: "2",
      expectedBuildId: build.buildId,
    });
    expect(preflight).toMatchObject({
      eligible: true,
      catalogId: build.catalogId,
      resourceRevision: "0",
      readinessId,
      buildId: build.buildId,
    });
    if (!preflight.eligible) throw new Error("expected eligible preflight");
    const result = await service.create(ownerId, build.appId, {
      organizationId,
      clientRequestId: "80000000-0000-4000-8000-000000000001",
      expectedResourceRevision: "0",
      expectedReadinessRevision: "2",
      readinessId,
      buildId: build.buildId,
      confirmationToken: preflight.confirmationToken,
    });
    expect(result).toMatchObject({
      scopeId,
      organizationId,
      owner: { actorId: ownerId, displayName: "Owner" },
      build,
      readinessId,
      state: "active",
      shareRevision: "1",
      dataRevision: "0",
    });
    expect(readinessRepository.getCurrent).toHaveBeenNthCalledWith(1, {
      ownerId, catalogId: build.catalogId, buildId: build.buildId,
    });
    expect(readinessRepository.getCurrent).toHaveBeenNthCalledWith(2, {
      ownerId, catalogId: build.catalogId, buildId: build.buildId,
    });
    expect(shares.createAtomic).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      organizationId,
      catalogId: build.catalogId,
      readinessId,
      expectedResourceRevision: 0,
      expectedReadinessRevision: 2,
      expectedBuildId: build.buildId,
      runtimeId: "runtime_owner",
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("fails closed for blocked, stale, mismatched-organization, tampered, and expired confirmation state", async () => {
    const blocked = setup({ readiness: { ...readiness, status: "blocked" } });
    await expect(blocked.service.preflight(ownerId, build.appId, {
      organizationId, expectedReadinessRevision: "2", expectedBuildId: build.buildId,
    })).resolves.toEqual({ eligible: false, reason: "not_ready" });

    const stale = setup();
    await expect(stale.service.preflight(ownerId, build.appId, {
      organizationId, expectedReadinessRevision: "1", expectedBuildId: build.buildId,
    })).resolves.toEqual({ eligible: false, reason: "readiness_stale" });

    const occupied = setup({ existing: { ...storedShare, organizationId: "org_other" } });
    await expect(occupied.service.preflight(ownerId, build.appId, {
      organizationId, expectedReadinessRevision: "2", expectedBuildId: build.buildId,
    })).resolves.toEqual({ eligible: false, reason: "organization_mismatch" });

    const { service } = setup();
    const valid = await service.preflight(ownerId, build.appId, {
      organizationId, expectedReadinessRevision: "2", expectedBuildId: build.buildId,
    });
    if (!valid.eligible) throw new Error("expected eligible preflight");
    const create = {
      organizationId,
      clientRequestId: "80000000-0000-4000-8000-000000000001",
      expectedResourceRevision: "0",
      expectedReadinessRevision: "2",
      readinessId,
      buildId: build.buildId,
      confirmationToken: `${valid.confirmationToken.slice(0, -1)}x`,
    };
    await expect(service.create(ownerId, build.appId, create)).rejects.toMatchObject({ code: "conflict" });

    const expired = setup({ now: new Date(NOW.getTime() + 61_000) }).service;
    await expect(expired.create(ownerId, build.appId, { ...create,
      confirmationToken: valid.confirmationToken })).rejects.toMatchObject({ code: "conflict" });
  });

  it("projects existing exact state and stops with both scope and binding revisions", async () => {
    const { service, shares, onStopped } = setup({ existing: storedShare });
    await expect(service.get(ownerId, build.appId)).resolves.toMatchObject({
      scopeId, state: "active", shareRevision: "1", dataRevision: "0",
    });
    await expect(service.preflight(ownerId, build.appId, {
      organizationId, expectedReadinessRevision: "2", expectedBuildId: build.buildId,
    })).resolves.toMatchObject({ eligible: true, existingShare: { scopeId, state: "active" } });
    await expect(service.stop(ownerId, build.appId, {
      clientRequestId: "80000000-0000-4000-8000-000000000002",
      expectedShareRevision: "1",
      expectedBindingRevision: "1",
    })).resolves.toMatchObject({ scopeId, state: "stopped", shareRevision: "2" });
    expect(shares.stopAtomic).toHaveBeenCalledWith(expect.objectContaining({
      scopeId,
      ownerId,
      expectedScopeRevision: 1,
      expectedBindingRevision: 1,
      clientRequestId: "80000000-0000-4000-8000-000000000002",
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(onStopped).toHaveBeenCalledWith(scopeId);
  });

  it("does not revoke current sessions when an old stop request replays after sharing restarts", async () => {
    const { service, shares, onStopped } = setup({ existing: storedShare });
    shares.stopAtomic.mockResolvedValueOnce({
      ...storedShare,
      scopeRevision: 3,
      authEpoch: 3,
      didStop: false,
      binding: { ...binding, revision: 3 },
    });
    await expect(service.stop(ownerId, build.appId, {
      clientRequestId: "80000000-0000-4000-8000-000000000002",
      expectedShareRevision: "1",
      expectedBindingRevision: "1",
    })).resolves.toMatchObject({ scopeId, state: "active", shareRevision: "3" });
    expect(onStopped).not.toHaveBeenCalled();
  });

  it("allows a stopped share to preflight again without treating it as active", async () => {
    const stopped = {
      ...storedShare,
      scopeRevision: 2,
      binding: { ...binding, state: "stopped" as const, revision: 2, stoppedAt: NOW.toISOString() },
    };
    const { service } = setup({ existing: stopped });

    const result = await service.preflight(ownerId, build.appId, {
      organizationId,
      expectedReadinessRevision: "2",
      expectedBuildId: build.buildId,
    });

    expect(result).toMatchObject({ eligible: true, catalogId: build.catalogId });
    expect(result).not.toHaveProperty("existingShare");
  });

  it("replays a completed create before expired-token and changed-build preconditions", async () => {
    const initial = setup();
    const preflight = await initial.service.preflight(ownerId, build.appId, {
      organizationId, expectedReadinessRevision: "2", expectedBuildId: build.buildId,
    });
    if (!preflight.eligible) throw new Error("expected eligible preflight");
    const replay = setup({ now: new Date(NOW.getTime() + 61_000), createReplay: storedShare });
    replay.resolveCurrentBuild.mockRejectedValue(new Error("build changed"));

    await expect(replay.service.create(ownerId, build.appId, {
      organizationId,
      clientRequestId: "80000000-0000-4000-8000-000000000001",
      expectedResourceRevision: "0",
      expectedReadinessRevision: "2",
      readinessId,
      buildId: build.buildId,
      confirmationToken: preflight.confirmationToken,
    })).resolves.toMatchObject({ scopeId, state: "active" });
    expect(replay.resolveCurrentBuild).not.toHaveBeenCalled();
  });

  it("loads and stops the saved share without rebuilding a now-broken app", async () => {
    const { service, resolveCurrentBuild } = setup({ existing: storedShare });
    resolveCurrentBuild.mockRejectedValue(new Error("broken matrix.json"));

    await expect(service.get(ownerId, build.appId)).resolves.toMatchObject({ scopeId, state: "active" });
    await expect(service.stop(ownerId, build.appId, {
      clientRequestId: "80000000-0000-4000-8000-000000000003",
      expectedShareRevision: "1",
      expectedBindingRevision: "1",
    })).resolves.toMatchObject({ scopeId, state: "stopped" });
    expect(resolveCurrentBuild).not.toHaveBeenCalled();
  });
});
