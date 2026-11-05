import { describe, expect, it, vi } from "vitest";

import {
  APPROVED_COLLABORATIVE_APP_READINESS_GATES,
  CollaborativeAppReadinessEvaluator,
  UnconfiguredSecondPrincipalVerifier,
} from "../../packages/gateway/src/collaboration/collaborative-app-readiness.js";
import { CollaborativeAppReadinessRepositoryError } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { evaluateCollaborativeAppProviderSafety } from "../../packages/gateway/src/collaboration/shared-provider-readiness.js";

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

function checking() {
  return {
    id: "60000000-0000-4000-8000-000000000001",
    ownerId: "user_owner",
    build,
    artifactRef: `objects/${build.buildId}`,
    status: "checking" as const,
    gateResults: [],
    verifiedAt: null,
    invalidatedAt: null,
    invalidationReason: null,
    verifierVersion: "collaborative-app-v1",
    revision: 1,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
  };
}

function repository() {
  const initial = checking();
  return {
    createOrGet: vi.fn(async () => initial),
    transition: vi.fn(async (input) => ({
      ...initial,
      status: input.status,
      gateResults: input.gateResults,
      verifiedAt: input.verifiedAt?.toISOString() ?? null,
      revision: 2,
    })),
    get: vi.fn(async () => null),
  };
}

const input = {
  ownerId: "user_owner",
  organizationId: "org_matrix_team",
  build,
  artifactRef: `objects/${build.buildId}`,
};

describe("collaborative app readiness evaluator", () => {
  it("blocks required creator credentials, connected providers, and AI funding without delegation", () => {
    expect(evaluateCollaborativeAppProviderSafety({
      required: ["connected_provider", "ai_funding"],
      participantScoped: [],
    })).toEqual({
      code: "provider_safety",
      status: "blocked",
      action: "This app requires owner-only services that are not available to organization participants.",
    });
    expect(evaluateCollaborativeAppProviderSafety({
      required: ["connected_provider"],
      participantScoped: ["connected_provider"],
    })).toEqual({ code: "provider_safety", status: "passed" });
  });

  it("fails closed with one safe actionable gate while the second principal is unconfigured", async () => {
    const records = repository();
    const result = await new CollaborativeAppReadinessEvaluator({
      repository: records as never,
      verifier: new UnconfiguredSecondPrincipalVerifier(),
      now: () => new Date("2026-11-05T11:00:00.000Z"),
    }).check(input);
    expect(result).toMatchObject({
      status: "blocked",
      gateResults: [{
        code: "two_principal_round_trip",
        status: "blocked",
        action: "A second authenticated verifier is not configured yet.",
      }],
    });
    expect(result.verifiedAt).toBeNull();
  });

  it("issues ready only from an approved verifier that proves every production gate", async () => {
    const records = repository();
    const verify = vi.fn(async () => APPROVED_COLLABORATIVE_APP_READINESS_GATES
      .map((code) => ({ code, status: "passed" as const })));
    const result = await new CollaborativeAppReadinessEvaluator({
      repository: records as never,
      verifier: { approval: "approved", verify },
      now: () => new Date("2026-11-05T11:00:00.000Z"),
    }).check(input);
    expect(result.status).toBe("ready");
    expect(result.verifiedAt).toBe("2026-11-05T11:00:00.000Z");
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: input.ownerId,
      organizationId: input.organizationId,
      build,
    }), expect.any(AbortSignal));

    const defaultClockResult = await new CollaborativeAppReadinessEvaluator({
      repository: repository() as never,
      verifier: { approval: "approved", verify },
    }).check(input);
    expect(defaultClockResult.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("maps incomplete proof and raw verifier failures to bounded failed results", async () => {
    for (const verifier of [
      { approval: "approved" as const, verify: async () => [{ code: "declaration" as const, status: "passed" as const }] },
      { approval: "approved" as const, verify: async () => [
        { code: "declaration" as const, status: "passed" as const },
        { code: "declaration" as const, status: "passed" as const },
      ] },
      { approval: "approved" as const, verify: async () => { throw new Error("postgres password=secret"); } },
      { approval: "approved" as const, verify: async () => { throw "database-secret"; } },
    ]) {
      const records = repository();
      const result = await new CollaborativeAppReadinessEvaluator({ repository: records as never, verifier }).check(input);
      expect(result).toMatchObject({
        status: "failed",
        gateResults: [{ code: "cleanup", status: "failed", action: "Readiness could not be verified. Try again." }],
      });
      expect(JSON.stringify(result)).not.toContain("postgres");
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("maps approved complete blocked and failed proofs without a verified timestamp", async () => {
    for (const expectedStatus of ["blocked", "failed"] as const) {
      const records = repository();
      const proof = APPROVED_COLLABORATIVE_APP_READINESS_GATES.map((code) => ({
        code,
        status: code === "cleanup" ? expectedStatus : "passed" as const,
        ...(code === "cleanup" ? { action: "Fix the cleanup path and recheck." } : {}),
      }));
      const result = await new CollaborativeAppReadinessEvaluator({
        repository: records as never,
        verifier: { approval: "approved", verify: async () => proof },
      }).check(input);
      expect(result).toMatchObject({ status: expectedStatus, verifiedAt: null });
    }
  });

  it("returns the concurrent winner after a CAS conflict and preserves unexpected repository failures", async () => {
    const winner = { ...checking(), status: "blocked" as const, revision: 2, gateResults: [{
      code: "two_principal_round_trip" as const,
      status: "blocked" as const,
      action: "A concurrent check completed first.",
    }] };
    const records = repository();
    records.transition.mockRejectedValue(new CollaborativeAppReadinessRepositoryError("conflict"));
    records.get.mockResolvedValue(winner);
    await expect(new CollaborativeAppReadinessEvaluator({
      repository: records as never,
      verifier: new UnconfiguredSecondPrincipalVerifier(),
    }).check(input)).resolves.toEqual(winner);

    records.get.mockResolvedValue(null);
    await expect(new CollaborativeAppReadinessEvaluator({
      repository: records as never,
      verifier: new UnconfiguredSecondPrincipalVerifier(),
    }).check(input)).rejects.toMatchObject({ code: "conflict" });
    records.transition.mockRejectedValue(new Error("repository unavailable"));
    await expect(new CollaborativeAppReadinessEvaluator({
      repository: records as never,
      verifier: new UnconfiguredSecondPrincipalVerifier(),
    }).check(input)).rejects.toThrow("repository unavailable");
  });

  it("replays a completed exact-build result without rerunning the verifier", async () => {
    const records = repository();
    records.createOrGet.mockResolvedValue({
      ...checking(),
      status: "blocked",
      revision: 2,
      gateResults: [{ code: "two_principal_round_trip", status: "blocked", action: "Configure a verifier." }],
    });
    const verify = vi.fn();
    const result = await new CollaborativeAppReadinessEvaluator({
      repository: records as never,
      verifier: { approval: "approved", verify },
    }).check(input);
    expect(result.status).toBe("blocked");
    expect(verify).not.toHaveBeenCalled();
    expect(records.transition).not.toHaveBeenCalled();
  });
});
