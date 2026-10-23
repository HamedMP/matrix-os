import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import {
  initializePreviewRuntimeAccess,
  loadPreviewRuntimeAccessConfig,
} from "../../packages/platform/src/preview-runtime-access.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";
import { createSpeechOperationsRepository, SpeechOperationRateLimitError } from "../../packages/platform/src/speech/operations.js";

const machineId = "71cf5b5b-f624-4c1c-9b6c-4dd2d46b2b02";
const identity = { ownerId: "user_preview", machineId, runtimeSlot: "pr-2383" } as const;
const now = "2026-10-20T10:00:00.000Z";
const modelId = "anthropic/claude-sonnet-5";

function enabledConfig() {
  return loadPreviewRuntimeAccessConfig({
    MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
    MATRIX_PREVIEW_RUNTIME_SECRET: "p".repeat(32),
    PLATFORM_SECRET: "x".repeat(32),
    MATRIX_PREVIEW_RUNTIME_TTL_MS: String(6 * 60 * 60_000),
    MATRIX_PREVIEW_AI_BUDGET_MICROUSD: "1000",
    MATRIX_PREVIEW_AI_REQUEST_LIMIT: "2",
    MATRIX_PREVIEW_SPEECH_REQUEST_LIMIT: "2",
    MATRIX_PREVIEW_MAX_CONCURRENCY: "1",
  });
}

describe("bounded Preview runtime access", () => {
  let db: PlatformDB;
  let clock: Date;
  let repository: ReturnType<typeof createAiFundedPolicyRepository>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(now);
    await insertUserMachine(db, {
      machineId,
      clerkUserId: identity.ownerId,
      handle: identity.runtimeSlot,
      runtimeSlot: identity.runtimeSlot,
      provisioningClass: "preview",
      activationState: "authorized",
      status: "running",
      imageVersion: "preview-build",
      provisionedAt: now,
    });
    await db.executor.updateTable("ai_funded_global_policy").set({
      enabled: true,
      allowed_model_ids: JSON.stringify([modelId]),
      revision: 1,
      updated_at: now,
    }).where("policy_id", "=", "default").execute();
    let token = 0;
    repository = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock),
      tokenIdFactory: () => `preview_credential_${++token}`,
      tokenSecretFactory: () => "s".repeat(43),
      issueCooldownMs: 1_000,
    });
  });

  afterEach(async () => destroyTestPlatformDb(db));

  it("requires a distinct Preview secret and bounded limits", () => {
    expect(() => loadPreviewRuntimeAccessConfig({
      MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
      MATRIX_PREVIEW_RUNTIME_SECRET: "x".repeat(32),
      PLATFORM_SECRET: "x".repeat(32),
    })).toThrow("Preview runtime access is misconfigured");
    expect(() => loadPreviewRuntimeAccessConfig({
      MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
      MATRIX_PREVIEW_RUNTIME_SECRET: "p".repeat(32),
      PLATFORM_SECRET: "x".repeat(32),
      MATRIX_PREVIEW_AI_REQUEST_LIMIT: "101",
    })).toThrow("Preview runtime access is misconfigured");
    expect(loadPreviewRuntimeAccessConfig({})).toEqual({ enabled: false });
  });

  it("atomically creates one expiring Preview-only policy and never refills it", async () => {
    const request = { ...identity, expectedRuntimeTokenEpoch: 1 };
    const first = await initializePreviewRuntimeAccess({ db, repository, config: enabledConfig(), request, now: () => new Date(clock) });
    expect(first).toMatchObject({
      identity: { ...identity, runtimeTokenEpoch: 1 },
      ai: { requestLimit: 2, requestsUsed: 0, requestsRemaining: 2, budgetMicrousd: 1000 },
      speech: { requestLimit: 2, requestsUsed: 0, requestsRemaining: 2 },
      maxConcurrency: 1,
    });
    expect(Date.parse(first.expiresAt) - clock.getTime()).toBe(6 * 60 * 60_000);

    const credential = await repository.issueRuntimeCredential(identity);
    const firstUse = await repository.authorize({
      credential: credential.credential.token,
      requestId: "preview_request_1",
      modelId,
      maxCostMicrousd: 100,
    });
    await repository.releaseReservation({
      reservationId: firstUse.reservation.reservationId,
      tokenId: credential.credential.tokenId,
      reason: "pre_upstream_failure",
    });

    const replayedActivation = await initializePreviewRuntimeAccess({ db, repository, config: enabledConfig(), request, now: () => new Date(clock) });
    expect(replayedActivation.ai).toMatchObject({ requestsUsed: 1, requestsRemaining: 1 });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(1);
  });

  it("gives an exact owner-only Private Preview its own bounded allocation", async () => {
    const privateIdentity = {
      ownerId: identity.ownerId,
      machineId,
      runtimeSlot: "pv-2383-deadbeef",
    } as const;
    await db.executor.updateTable("user_machines").set({
      handle: privateIdentity.runtimeSlot,
      runtime_slot: privateIdentity.runtimeSlot,
      provisioning_class: "private-preview",
      source_pr: 2383,
      confirmed_bundle_version: "preview-build",
    }).where("machine_id", "=", machineId).execute();

    const allocation = await initializePreviewRuntimeAccess({
      db,
      repository,
      config: enabledConfig(),
      request: { ...privateIdentity, expectedRuntimeTokenEpoch: 1 },
      now: () => new Date(clock),
    });
    expect(allocation).toMatchObject({
      identity: { ...privateIdentity, runtimeTokenEpoch: 1 },
      ai: { requestLimit: 2, requestsRemaining: 2 },
      speech: { requestLimit: 2, requestsRemaining: 2 },
    });

    const credential = await repository.issueRuntimeCredential(privateIdentity);
    const authorization = await repository.authorize({
      credential: credential.credential.token,
      requestId: "private_preview_request_1",
      modelId,
      maxCostMicrousd: 100,
    });
    expect(authorization.identity).toMatchObject(privateIdentity);
    expect(await repository.getRuntimeFundingSummary(privateIdentity, { includeChatAvailability: true }))
      .toMatchObject({ funding: { previewQuota: { requestsRemaining: 1 } } });
  });

  it("enforces the hard AI request limit without consuming an owner-primary balance", async () => {
    await insertUserMachine(db, {
      machineId: "primary-machine",
      clerkUserId: identity.ownerId,
      handle: "primary-owner",
      runtimeSlot: "primary",
      provisioningClass: "customer",
      activationState: "authorized",
      status: "running",
      imageVersion: "stable",
      provisionedAt: now,
    });
    await db.executor.insertInto("ai_funded_runtime_balances").values({
      machine_id: "primary-machine", owner_id: identity.ownerId, runtime_slot: "primary",
      credit_balance_microusd: 123_456, promotional_balance_microusd: 0,
      addon_balance_microusd: 123_456, reserved_microusd: 0, funding_shortfall_microusd: 0,
      month_period_start: "2026-10-01", month_spent_microusd: 100, month_reserved_microusd: 0,
      updated_at: now,
    }).execute();
    const primaryBefore = await db.executor.selectFrom("ai_funded_runtime_balances").selectAll()
      .where("machine_id", "=", "primary-machine").executeTakeFirstOrThrow();
    await initializePreviewRuntimeAccess({
      db,
      repository,
      config: enabledConfig(),
      request: { ...identity, expectedRuntimeTokenEpoch: 1 },
      now: () => new Date(clock),
    });
    const credential = await repository.issueRuntimeCredential(identity);
    for (const requestId of ["preview_request_a", "preview_request_b"]) {
      const authorization = await repository.authorize({
        credential: credential.credential.token,
        requestId,
        modelId,
        maxCostMicrousd: 100,
      });
      await repository.releaseReservation({
        reservationId: authorization.reservation.reservationId,
        tokenId: credential.credential.tokenId,
        reason: "pre_upstream_failure",
      });
    }
    await expect(repository.authorize({
      credential: credential.credential.token,
      requestId: "preview_request_c",
      modelId,
      maxCostMicrousd: 100,
    })).rejects.toMatchObject({ code: "access_disabled" });
    expect(await db.executor.selectFrom("preview_runtime_allocations")
      .select(["ai_requests_used", "ai_request_limit"]).executeTakeFirstOrThrow())
      .toEqual({ ai_requests_used: 2, ai_request_limit: 2 });
    expect(await repository.getRuntimeFundingSummary(identity, { includeChatAvailability: true }))
      .toMatchObject({
        funding: { previewQuota: { requestsRemaining: 0 } },
        policy: { enabled: false, allowedModelIds: [] },
        chatAvailability: { eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 },
      });
    expect(await db.executor.selectFrom("ai_funded_runtime_balances").selectAll()
      .where("machine_id", "=", "primary-machine").executeTakeFirstOrThrow()).toEqual(primaryBefore);
  });

  it("enforces one active Preview operation across hold-mode Chat requests", async () => {
    await initializePreviewRuntimeAccess({ db, repository, config: enabledConfig(),
      request: { ...identity, expectedRuntimeTokenEpoch: 1 }, now: () => new Date(clock) });
    const credential = await repository.issueRuntimeCredential(identity);
    await repository.authorize({ credential: credential.credential.token,
      requestId: "preview_active_chat_a", modelId, maxCostMicrousd: 100 });
    await expect(repository.authorize({ credential: credential.credential.token,
      requestId: "preview_active_chat_b", modelId, maxCostMicrousd: 100 }))
      .rejects.toMatchObject({ code: "rate_limited", reason: "slot_busy" });
  });

  it("blocks dictation while funded Preview Chat is active", async () => {
    await initializePreviewRuntimeAccess({ db, repository, config: enabledConfig(),
      request: { ...identity, expectedRuntimeTokenEpoch: 1 }, now: () => new Date(clock) });
    const credential = await repository.issueRuntimeCredential(identity);
    await repository.authorize({ credential: credential.credential.token,
      requestId: "preview_chat_before_speech", modelId, maxCostMicrousd: 100 });
    const operations = createSpeechOperationsRepository({ db, now: () => new Date(clock),
      maximumActiveOperations: 10, maximumActiveOperationsPerOwner: 10 });
    await expect(operations.admit({ identity,
      requestId: `sp_${clock.getTime()}_${"chatfirst".padEnd(16, "a")}`,
      sourceKind: "dictation", contentFingerprint: "a".repeat(64), policyRevision: "speech-1",
      adapterId: "openai-file", modelId: "gpt-4o-transcribe", audioDurationMs: 1000,
      maximumCostMicrousd: 10 }, async () => ({ reservationId: "preview_speech_after_chat", reservedMicrousd: 0 })))
      .rejects.toBeInstanceOf(SpeechOperationRateLimitError);
  });

  it("blocks funded Preview Chat while dictation is active", async () => {
    await initializePreviewRuntimeAccess({ db, repository, config: enabledConfig(),
      request: { ...identity, expectedRuntimeTokenEpoch: 1 }, now: () => new Date(clock) });
    const operations = createSpeechOperationsRepository({ db, now: () => new Date(clock),
      maximumActiveOperations: 10, maximumActiveOperationsPerOwner: 10 });
    await operations.admit({ identity,
      requestId: `sp_${clock.getTime()}_${"speechfirst".padEnd(16, "a")}`,
      sourceKind: "dictation", contentFingerprint: "b".repeat(64), policyRevision: "speech-1",
      adapterId: "openai-file", modelId: "gpt-4o-transcribe", audioDurationMs: 1000,
      maximumCostMicrousd: 10 }, async () => ({ reservationId: "preview_speech_before_chat", reservedMicrousd: 0 }));
    const credential = await repository.issueRuntimeCredential(identity);
    await expect(repository.authorize({ credential: credential.credential.token,
      requestId: "preview_chat_after_speech", modelId, maxCostMicrousd: 100 }))
      .rejects.toMatchObject({ code: "rate_limited", reason: "slot_busy" });
  });

  it("authenticates Preview runtime routes only with the separate exact-generation token", async () => {
    await initializePreviewRuntimeAccess({ db, repository, config: enabledConfig(),
      request: { ...identity, expectedRuntimeTokenEpoch: 1 }, now: () => new Date(clock) });
    const routes = createAiFundedRuntimeRoutes({ db, repository,
      platformSecret: "x".repeat(32), previewRuntimeSecret: "p".repeat(32), now: () => new Date(clock) });
    const app = new Hono().route("/:handle/ai", routes);
    const token = (secret: string) => buildPlatformRuntimeVerificationToken({
      handle: identity.runtimeSlot, machineId, runtimeSlot: identity.runtimeSlot,
    }, secret, 1);
    const request = (secret: string) => app.request(`/${identity.runtimeSlot}/ai/funding-summary?runtimeSlot=${identity.runtimeSlot}`, {
      method: "POST", headers: { authorization: `Bearer ${token(secret)}`, "content-type": "application/json" },
      body: JSON.stringify({ includeChatAvailability: true }),
    });
    expect((await request("x".repeat(32))).status).toBe(401);
    const response = await request("p".repeat(32));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ funding: { previewQuota: {
      mode: "preview", requestLimit: 2, requestsUsed: 0, requestsRemaining: 2, maxConcurrency: 1,
    } } });

    const previewToken = token("p".repeat(32));
    const phase = { target: { kind: "canonical_bot" as const, botId: "bot_preview01",
      recipeRef: { recipeId: "matrix-bot", version: "1.0.0" } }, phaseId: "preview_phase", ...identity,
      runtimeTokenEpoch: 1, runtimeCredentialSha256: createHash("sha256").update(previewToken).digest("hex"),
      chatId: "chat_preview", modelId, sourceSha: "a".repeat(40), startsAt: now,
      expiresAt: "2026-10-20T10:30:00.000Z" };
    const phasedRoutes = createAiFundedRuntimeRoutes({ db, repository,
      platformSecret: "x".repeat(32), previewRuntimeSecret: "p".repeat(32), now: () => new Date(clock),
      isolatedChat: phase });
    const phasedApp = new Hono().route("/:handle/ai", phasedRoutes);
    const phasedResponse = await phasedApp.request(`/${identity.runtimeSlot}/ai/funding-summary?runtimeSlot=${identity.runtimeSlot}`, {
      method: "POST", headers: { authorization: `Bearer ${previewToken}`, "content-type": "application/json",
        "x-matrix-isolated-chat-phase": phase.phaseId,
        "x-matrix-isolated-chat-config": createHash("sha256").update(JSON.stringify(phase)).digest("hex") },
      body: JSON.stringify({ includeChatAvailability: true }),
    });
    expect(phasedResponse.status).toBe(200);
    expect(await phasedResponse.json()).toMatchObject({ funding: { previewQuota: {
      mode: "preview", requestLimit: 2, requestsUsed: 0, requestsRemaining: 2, maxConcurrency: 1,
    } } });

    await insertUserMachine(db, { machineId: "other-preview-machine", clerkUserId: "user_other",
      handle: "pr-9999", runtimeSlot: "pr-9999", provisioningClass: "preview",
      activationState: "authorized", status: "running", imageVersion: "preview", provisionedAt: now });
    const replay = await app.request("/pr-9999/ai/funding-summary?runtimeSlot=pr-9999", {
      method: "POST", headers: { authorization: `Bearer ${token("p".repeat(32))}`, "content-type": "application/json" },
      body: JSON.stringify({ includeChatAvailability: true }),
    });
    expect(replay.status).toBe(401);
  });

  it.each([
    { ownerId: "user_other" },
    { runtimeSlot: "pr-9999" },
    { expectedRuntimeTokenEpoch: 2 },
  ])("rejects an activation identity mismatch: %j", async mismatch => {
    await expect(initializePreviewRuntimeAccess({
      db,
      repository,
      config: enabledConfig(),
      request: { ...identity, expectedRuntimeTokenEpoch: 1, ...mismatch },
      now: () => new Date(clock),
    })).rejects.toThrow("Preview runtime is ineligible");
    expect(await db.executor.selectFrom("preview_runtime_allocations").selectAll().execute()).toEqual([]);
  });

  it("invalidates old access on expiry, token epoch rotation, deletion, and recreation", async () => {
    await initializePreviewRuntimeAccess({
      db,
      repository,
      config: enabledConfig(),
      request: { ...identity, expectedRuntimeTokenEpoch: 1 },
      now: () => new Date(clock),
    });
    const credential = await repository.issueRuntimeCredential(identity);
    clock = new Date(clock.getTime() + 6 * 60 * 60_000 + 1);
    await expect(repository.authorize({ credential: credential.credential.token,
      requestId: "expired_preview", modelId, maxCostMicrousd: 1 })).rejects.toMatchObject({
        code: expect.stringMatching(/unauthorized|access_disabled/),
      });

    clock = new Date(now);
    await db.executor.updateTable("user_machines").set({ runtime_token_epoch: 2 }).where("machine_id", "=", machineId).execute();
    await expect(repository.issueRuntimeCredential(identity)).rejects.toMatchObject({ code: "access_disabled" });

    await db.executor.deleteFrom("user_machines").where("machine_id", "=", machineId).execute();
    expect(await db.executor.selectFrom("preview_runtime_allocations").selectAll().execute()).toEqual([]);
    const recreatedMachineId = "ebdb327f-f9c0-46b2-8bc3-5ef08542043d";
    await insertUserMachine(db, { machineId: recreatedMachineId, clerkUserId: identity.ownerId,
      handle: identity.runtimeSlot, runtimeSlot: identity.runtimeSlot, provisioningClass: "preview",
      activationState: "authorized", status: "running", imageVersion: "preview-build-2", provisionedAt: now });
    await initializePreviewRuntimeAccess({ db, repository, config: enabledConfig(),
      request: { ...identity, machineId: recreatedMachineId, expectedRuntimeTokenEpoch: 1 }, now: () => new Date(clock) });
    await expect(repository.authorize({ credential: credential.credential.token,
      requestId: "recreated_preview", modelId, maxCostMicrousd: 1 }))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("never turns a customer-primary machine into a Preview allocation", async () => {
    await db.executor.updateTable("user_machines").set({
      provisioning_class: "customer",
      handle: "primary-owner",
      runtime_slot: "primary",
    }).where("machine_id", "=", machineId).execute();
    await expect(initializePreviewRuntimeAccess({
      db,
      repository,
      config: enabledConfig(),
      request: { ownerId: identity.ownerId, machineId, runtimeSlot: "primary", expectedRuntimeTokenEpoch: 1 },
      now: () => new Date(clock),
    })).rejects.toThrow("Preview runtime is ineligible");
  });
});
