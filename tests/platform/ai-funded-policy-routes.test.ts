import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FundedAiAuthorizationResponseSchema,
  FundedAiOperatorGlobalPolicyResponseSchema,
  FundedAiOperatorRuntimePolicyResponseSchema,
  FundedAiPromotionalGrantResponseSchema,
  FundedAiRuntimeCredentialIssueResponseSchema,
  FundedAiRuntimeFundingSummaryResponseSchema,
  FundedAiSettlementResponseSchema,
  FundedAiStartResponseSchema,
} from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import {
  createAiFundedRelayRoutes,
  createAiFundedOperatorRoutes,
  createAiFundedRuntimeRoutes,
  loadAiFundedControlPlaneConfig,
} from "../../packages/platform/src/ai-funded-policy-routes.js";
import { insertContainer, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const platformSecret = "platform-secret-for-tests-123456789";
const relayControlToken = "relay-control-token-for-tests-123456";
const hashSecret = "credential-hash-secret-for-tests-123";
const now = "2026-08-30T20:00:00.000Z";
const modelId = "anthropic/claude-sonnet-5";

function bearerFor(handle: string, machineId = "machine_123", runtimeSlot = "primary"): string {
  return buildPlatformRuntimeVerificationToken({ handle, machineId, runtimeSlot }, platformSecret);
}

function fundedCredentialPath(handle = "alice", runtimeSlot = "primary"): string {
  return `/internal/containers/${handle}/ai/funded-credential?runtimeSlot=${runtimeSlot}`;
}

function stubOrchestrator(): Orchestrator {
  return {
    provision: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), upgrade: vi.fn(),
    rollingRestart: vi.fn(), getInfo: vi.fn(), getImage: vi.fn(), listAll: vi.fn().mockReturnValue([]),
    syncStates: vi.fn(),
  };
}

describe("funded AI policy routes", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: "machine_123", clerkUserId: "user_alice", handle: "alice", runtimeSlot: "primary",
      status: "running", imageVersion: "v1", provisionedAt: "2026-08-30T19:00:00.000Z",
      activationState: "authorized",
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    vi.restoreAllMocks();
  });

  async function createTestApp(options: { promotionalGrantEnabled?: boolean } = {}) {
    const repository = createAiFundedPolicyRepository({
      db, credentialHashSecret: hashSecret, now: () => new Date(now),
      tokenIdFactory: () => "credential_123", tokenSecretFactory: () => "s".repeat(43),
      issueCooldownMs: 60_000,
    });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repository.setRuntimePolicy({
      identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      expectedRevision: 0, enabled: true, allowedModelIds: [modelId], expiresAt: null,
      monthlyBudgetMicrousd: 1_000,
    });
    await repository.grantCredit({
      entryId: "grant_routes", identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      kind: "promotional_grant", amountMicrousd: 1_000, sourceReference: "route-fixture",
    });
    await repository.grantCredit({
      entryId: "grant_routes_addon", identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      kind: "addon_grant", amountMicrousd: 500, sourceReference: "route-addon-fixture",
    });
    return {
      repository,
      app: createApp({
        db,
        orchestrator: stubOrchestrator(),
        platformSecret,
        internalFundedAiRuntimeRoutes: createAiFundedRuntimeRoutes({ db, platformSecret, repository }),
        internalFundedAiRelayRoutes: createAiFundedRelayRoutes({ relayControlToken, repository }),
        internalFundedAiOperatorRoutes: createAiFundedOperatorRoutes({
          db,
          operatorSecret: platformSecret,
          repository,
          now: () => new Date(now),
          promotionalGrant: options.promotionalGrantEnabled
            ? {
                enabled: true,
                campaignId: "first-launch-2026",
                amountMicrousd: 250,
                expiresAt: "2026-09-30T20:00:00.000Z",
              }
            : { enabled: false },
        }),
      }),
    };
  }

  it("fails closed unless dedicated, distinct secrets are configured", () => {
    expect(loadAiFundedControlPlaneConfig({})).toEqual({ enabled: false });
    expect(() => loadAiFundedControlPlaneConfig({
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
      PLATFORM_SECRET: platformSecret,
      AI_RELAY_CONTROL_TOKEN: platformSecret,
      AI_FUNDED_CREDENTIAL_HASH_SECRET: hashSecret,
    })).toThrow(/misconfigured/i);
    expect(loadAiFundedControlPlaneConfig({
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
      PLATFORM_SECRET: platformSecret,
      AI_RELAY_CONTROL_TOKEN: relayControlToken,
      AI_FUNDED_CREDENTIAL_HASH_SECRET: hashSecret,
    })).toMatchObject({ enabled: true, credentialTtlMs: 900_000, promotionalGrant: { enabled: false } });
    expect(loadAiFundedControlPlaneConfig({
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
      PLATFORM_SECRET: platformSecret,
      AI_RELAY_CONTROL_TOKEN: relayControlToken,
      AI_FUNDED_CREDENTIAL_HASH_SECRET: hashSecret,
      AI_FUNDED_PROMOTIONAL_GRANT_ENABLED: "true",
      AI_FUNDED_PROMOTIONAL_GRANT_CAMPAIGN_ID: "first-launch-2026",
      AI_FUNDED_PROMOTIONAL_GRANT_MICROUSD: "250000",
      AI_FUNDED_PROMOTIONAL_GRANT_EXPIRES_AT: "2026-09-30T20:00:00.000Z",
    })).toMatchObject({
      enabled: true,
      promotionalGrant: {
        enabled: true,
        campaignId: "first-launch-2026",
        amountMicrousd: 250_000,
        expiresAt: "2026-09-30T20:00:00.000Z",
      },
    });
    expect(() => loadAiFundedControlPlaneConfig({
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
      PLATFORM_SECRET: platformSecret,
      AI_RELAY_CONTROL_TOKEN: relayControlToken,
      AI_FUNDED_CREDENTIAL_HASH_SECRET: hashSecret,
      AI_FUNDED_PROMOTIONAL_GRANT_ENABLED: "true",
      AI_FUNDED_PROMOTIONAL_GRANT_MICROUSD: "250000",
    })).toThrow(/misconfigured/i);
    expect(() => createAiFundedRelayRoutes({
      relayControlToken,
      repository: undefined as never,
    })).toThrow(/dependencies/i);
  });

  it("authenticates bounded operator policy changes and derives exact runtime identity", async () => {
    const { app, repository } = await createTestApp();
    const headers = { authorization: `Bearer ${platformSecret}`, "content-type": "application/json" };
    const currentGlobal = await app.request("/api/operator/ai/funded/global-policy", {
      headers: { authorization: `Bearer ${platformSecret}` },
    });
    expect(FundedAiOperatorGlobalPolicyResponseSchema.parse(await currentGlobal.json()))
      .toMatchObject({ policy: { revision: 1 } });
    const currentRuntime = await app.request("/api/operator/ai/funded/runtimes/alice/policy", {
      headers: { authorization: `Bearer ${platformSecret}` },
    });
    const currentRuntimeBody = FundedAiOperatorRuntimePolicyResponseSchema.parse(await currentRuntime.json());
    expect(currentRuntimeBody).toMatchObject({ policy: { revision: 1, monthlyBudgetMicrousd: 1_000 } });
    expect(JSON.stringify(currentRuntimeBody)).not.toMatch(/user_alice|machine_123|primary/i);
    expect((await app.request("/api/operator/ai/funded/global-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId] }),
    })).status).toBe(401);

    const global = await app.request("/api/operator/ai/funded/global-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId] }),
    });
    expect(global.status).toBe(200);
    expect(FundedAiOperatorGlobalPolicyResponseSchema.parse(await global.json()))
      .toMatchObject({ policy: { enabled: true, revision: 2, allowedModelIds: [modelId] } });

    const runtime = await app.request("/api/operator/ai/funded/runtimes/alice/policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        enabled: true,
        allowedModelIds: [modelId],
        monthlyBudgetMicrousd: 2_000,
        expiresAt: "2026-09-30T20:00:00.000Z",
      }),
    });
    expect(runtime.status).toBe(200);
    const runtimeBody = FundedAiOperatorRuntimePolicyResponseSchema.parse(await runtime.json());
    expect(runtimeBody).toMatchObject({
      policy: { enabled: true, revision: 2, monthlyBudgetMicrousd: 2_000 },
    });
    expect(JSON.stringify(runtimeBody)).not.toMatch(/user_alice|machine_123|primary/i);

    const spoof = await app.request("/api/operator/ai/funded/runtimes/alice/policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedRevision: 2,
        enabled: true,
        allowedModelIds: [modelId],
        monthlyBudgetMicrousd: 2_000,
        expiresAt: null,
        ownerId: "user_other",
      }),
    });
    expect(spoof.status).toBe(400);
    const stale = await app.request("/api/operator/ai/funded/runtimes/alice/policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        enabled: false,
        allowedModelIds: [],
        monthlyBudgetMicrousd: 0,
        expiresAt: null,
      }),
    });
    expect(stale.status).toBe(409);

    const oversized = await app.request("/api/operator/ai/funded/global-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({ padding: "x".repeat(5_000) }),
    });
    expect(oversized.status).toBe(413);
    const invalidQuery = await app.request("/api/operator/ai/funded/global-policy?ownerId=user_alice", {
      headers: { authorization: `Bearer ${platformSecret}` },
    });
    expect(invalidQuery.status).toBe(400);

    const unavailableApp = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret,
      internalFundedAiOperatorRoutes: createAiFundedOperatorRoutes({
        db,
        operatorSecret: platformSecret,
        repository: {
          ...repository,
          updateGlobalPolicy: vi.fn(async () => {
            throw new Error("postgresql://secret@db.internal");
          }),
        },
        promotionalGrant: { enabled: false },
      }),
    });
    const unavailable = await unavailableApp.request("/api/operator/ai/funded/global-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 2, enabled: false, allowedModelIds: [] }),
    });
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).toBe(
      JSON.stringify({ error: { code: "unavailable", message: "Service unavailable" } }),
    );
  });

  it("creates one configured promotional grant per campaign/runtime and stays disabled by default", async () => {
    const enabled = await createTestApp({ promotionalGrantEnabled: true });
    const disabledApp = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret,
      internalFundedAiOperatorRoutes: createAiFundedOperatorRoutes({
        db,
        operatorSecret: platformSecret,
        repository: enabled.repository,
        now: () => new Date(now),
        promotionalGrant: { enabled: false },
      }),
    });
    const headers = { authorization: `Bearer ${platformSecret}`, "content-type": "application/json" };
    expect((await disabledApp.request("/api/operator/ai/funded/runtimes/alice/promotional-grant", {
      method: "POST",
      headers,
      body: "{}",
    })).status).toBe(403);

    const { app } = enabled;
    const first = await app.request("/api/operator/ai/funded/runtimes/alice/promotional-grant", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(first.status).toBe(200);
    const firstBody = FundedAiPromotionalGrantResponseSchema.parse(await first.json());
    expect(firstBody).toMatchObject({
      grant: {
        kind: "promotional",
        amountMicrousd: 250,
        expiresAt: "2026-09-30T20:00:00.000Z",
        status: "active",
      },
    });
    expect(JSON.stringify(firstBody)).not.toMatch(/user_alice|machine_123|primary|campaign|entry/i);
    const replay = await app.request("/api/operator/ai/funded/runtimes/alice/promotional-grant", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(await replay.json()).toEqual(firstBody);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .selectAll().where("source_reference", "=", "first-launch-2026").execute()).toHaveLength(1);

    const oversized = await app.request("/api/operator/ai/funded/runtimes/alice/promotional-grant", {
      method: "POST",
      headers,
      body: JSON.stringify({ padding: "x".repeat(2_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("issues a scoped credential from the authenticated running machine record", async () => {
    const { app } = await createTestApp();
    const response = await app.request(fundedCredentialPath(), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const issued = FundedAiRuntimeCredentialIssueResponseSchema.parse(await response.json());
    expect(issued.identity).toEqual({ ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" });
    expect((await app.request(fundedCredentialPath(), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice", "machine_predecessor")}` },
    })).status).toBe(401);
    expect((await app.request(fundedCredentialPath(), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice", "machine_123", "staging")}` },
    })).status).toBe(401);
  });

  it("resolves the requested runtime slot before verifying exact machine proof", async () => {
    await insertUserMachine(db, {
      machineId: "machine_staging", clerkUserId: "user_alice", handle: "alice", runtimeSlot: "staging",
      status: "running", imageVersion: "v1", provisionedAt: "2026-08-30T19:30:00.000Z",
      activationState: "authorized",
    });
    const { app, repository } = await createTestApp();
    await repository.setRuntimePolicy({
      identity: { ownerId: "user_alice", machineId: "machine_staging", runtimeSlot: "staging" },
      expectedRevision: 0, enabled: true, allowedModelIds: [modelId], expiresAt: null,
      monthlyBudgetMicrousd: 1_000,
    });
    await repository.grantCredit({
      entryId: "grant_routes_staging",
      identity: { ownerId: "user_alice", machineId: "machine_staging", runtimeSlot: "staging" },
      kind: "promotional_grant",
      amountMicrousd: 1_000,
      sourceReference: "route-fixture-staging",
    });

    const response = await app.request(fundedCredentialPath("alice", "staging"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "machine_staging", "staging")}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    const issued = FundedAiRuntimeCredentialIssueResponseSchema.parse(await response.json());
    expect(issued.identity).toEqual({
      ownerId: "user_alice",
      machineId: "machine_staging",
      runtimeSlot: "staging",
    });
  });

  it("returns the exact identity-free Postgres funding summary for the authenticated runtime", async () => {
    const { app } = await createTestApp();
    const response = await app.request("/internal/containers/alice/ai/funding-summary?runtimeSlot=primary", {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const summary = FundedAiRuntimeFundingSummaryResponseSchema.parse(await response.json());
    expect(summary.funding).toMatchObject({
      monthlyBudgetMicrousd: 1_000,
      promotionalBalanceMicrousd: 1_000,
      addonBalanceMicrousd: 500,
      creditBalanceMicrousd: 1_500,
      remainingBalanceMicrousd: 1_500,
      remainingBudgetMicrousd: 1_000,
    });
    expect(JSON.stringify(summary)).not.toMatch(/user_alice|machine_123|primary|credential|token/i);
    expect((await app.request("/internal/containers/alice/ai/funding-summary?runtimeSlot=primary", {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice", "machine_predecessor")}` },
    })).status).toBe(401);
    expect((await app.request("/internal/containers/alice/ai/funding-summary", {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}` },
    })).status).toBe(400);
  });

  it("rejects missing auth, malformed or oversized bodies, caller identity fields, and legacy-only handles", async () => {
    const { app } = await createTestApp();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await app.request("/internal/containers/alice/ai/funded-credential", {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}` },
    })).status).toBe(400);
    expect((await app.request(fundedCredentialPath("alice", "invalid_slot"), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}` },
    })).status).toBe(400);
    expect((await app.request(fundedCredentialPath(), { method: "POST" })).status).toBe(401);
    const spoofed = await app.request(fundedCredentialPath(), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: JSON.stringify({ ownerId: "user_bob", machineId: "machine_other" }),
    });
    expect(spoofed.status).toBe(400);
    const malformedSecret = "sk-provider-do-not-log";
    const malformed = await app.request(fundedCredentialPath(), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: `{"credential":"${malformedSecret}"`,
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(warning).toHaveBeenCalledWith("[ai-funded-policy] invalid JSON body (syntax_error)");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(malformedSecret);
    const oversized = await app.request(fundedCredentialPath(), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2_000) }),
    });
    expect(oversized.status).toBe(413);

    const summarySpoof = await app.request("/internal/containers/alice/ai/funding-summary?ownerId=user_bob", {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(summarySpoof.status).toBe(400);
    const summaryBodySpoof = await app.request("/internal/containers/alice/ai/funding-summary", {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "machine_other" }),
    });
    expect(summaryBodySpoof.status).toBe(400);
    const summaryOversized = await app.request("/internal/containers/alice/ai/funding-summary", {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2_000) }),
    });
    expect(summaryOversized.status).toBe(413);

    await insertContainer(db, {
      handle: "legacy", clerkUserId: "user_legacy", port: 5001, shellPort: 6001, status: "running",
    });
    const legacy = await app.request(fundedCredentialPath("legacy"), {
      method: "POST", headers: { authorization: `Bearer ${bearerFor("legacy")}` },
    });
    expect(legacy.status).toBe(401);
  });

  it("authorizes only through the dedicated timing-safe relay service credential", async () => {
    const { app } = await createTestApp();
    const issuedResponse = await app.request(fundedCredentialPath(), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" },
      body: "{}",
    });
    const issued = FundedAiRuntimeCredentialIssueResponseSchema.parse(await issuedResponse.json());
    const body = JSON.stringify({
      credential: issued.credential.token, requestId: "request_123", modelId, maxCostMicrousd: 100,
    });

    const unauthenticated = await app.request("/internal/ai/funded/authorize", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(unauthenticated.status).toBe(401);
    const authorized = await app.request("/internal/ai/funded/authorize", {
      method: "POST",
      headers: { authorization: `Bearer ${relayControlToken}`, "content-type": "application/json" },
      body,
    });
    expect(authorized.status).toBe(200);
    const authorization = FundedAiAuthorizationResponseSchema.parse(await authorized.json());
    expect(authorization).toMatchObject({ authorized: true, identity: { ownerId: "user_alice" } });

    const lifecycleBody = {
      reservationId: authorization.reservation.reservationId,
      tokenId: issued.credential.tokenId,
    };
    const start = await app.request("/internal/ai/funded/start", {
      method: "POST",
      headers: { authorization: `Bearer ${relayControlToken}`, "content-type": "application/json" },
      body: JSON.stringify(lifecycleBody),
    });
    expect(FundedAiStartResponseSchema.parse(await start.json())).toMatchObject({ status: "in_flight" });
    const settle = await app.request("/internal/ai/funded/settle", {
      method: "POST",
      headers: { authorization: `Bearer ${relayControlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...lifecycleBody, actualCostMicrousd: 60 }),
    });
    expect(FundedAiSettlementResponseSchema.parse(await settle.json()))
      .toMatchObject({ status: "settled", actualCostMicrousd: 60 });

    const invalidRelease = await app.request("/internal/ai/funded/release", {
      method: "POST",
      headers: { authorization: `Bearer ${relayControlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...lifecycleBody, reason: "ambiguous_upstream_failure" }),
    });
    expect(invalidRelease.status).toBe(400);
  });
});
