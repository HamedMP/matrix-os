import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FundedAiAuthorizationResponseSchema,
  FundedAiRuntimeCredentialIssueResponseSchema,
  FundedAiSettlementResponseSchema,
  FundedAiStartResponseSchema,
} from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import {
  createAiFundedRelayRoutes,
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

  async function createTestApp() {
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
    return {
      repository,
      app: createApp({
        db,
        orchestrator: stubOrchestrator(),
        platformSecret,
        internalFundedAiRuntimeRoutes: createAiFundedRuntimeRoutes({ db, platformSecret, repository }),
        internalFundedAiRelayRoutes: createAiFundedRelayRoutes({ relayControlToken, repository }),
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
    })).toMatchObject({ enabled: true, credentialTtlMs: 900_000 });
    expect(() => createAiFundedRelayRoutes({
      relayControlToken,
      repository: undefined as never,
    })).toThrow(/dependencies/i);
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
