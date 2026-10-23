import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewAwareSpeechFundingPort } from "../../packages/platform/src/speech/preview-funding.js";
import { createSpeechRuntimeRoutes } from "../../packages/platform/src/speech/routes.js";
import { createSpeechOperationsRepository, SpeechOperationRateLimitError } from "../../packages/platform/src/speech/operations.js";
import type { PlatformSpeechService } from "../../packages/platform/src/speech/service.js";
import { buildPlatformSpeechRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import type { SpeechFundingPort } from "../../packages/platform/src/speech/service.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";
import { Hono } from "hono";

const now = new Date("2026-10-20T10:00:00.000Z");
const preview = { ownerId: "user_preview", machineId: "preview-machine", runtimeSlot: "pr-2383" } as const;
const customer = { ownerId: "user_customer", machineId: "customer-machine", runtimeSlot: "primary" } as const;

describe("Preview speech no-charge funding", () => {
  let db: PlatformDB;
  let paid: SpeechFundingPort;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: preview.machineId, clerkUserId: preview.ownerId,
      handle: preview.runtimeSlot, runtimeSlot: preview.runtimeSlot, provisioningClass: "preview",
      activationState: "authorized", status: "running", imageVersion: "preview", provisionedAt: now.toISOString() });
    await insertUserMachine(db, { machineId: customer.machineId, clerkUserId: customer.ownerId,
      handle: "customer", runtimeSlot: customer.runtimeSlot, provisioningClass: "customer",
      activationState: "authorized", status: "running", imageVersion: "stable", provisionedAt: now.toISOString() });
    await db.executor.insertInto("preview_runtime_allocations").values({
      machine_id: preview.machineId,
      owner_id: preview.ownerId,
      runtime_slot: preview.runtimeSlot,
      runtime_token_epoch: 1,
      ai_budget_microusd: 1000,
      ai_request_limit: 2,
      ai_requests_used: 0,
      speech_request_limit: 2,
      speech_requests_used: 0,
      max_concurrency: 1,
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).execute();
    paid = {
      reserve: vi.fn(async () => ({ reservationId: "paid-reservation", reservedMicrousd: 10 })),
      start: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => destroyTestPlatformDb(db));

  const reserve = (identity: typeof preview | typeof customer, suffix: string) => db.transaction(trx =>
    createPreviewAwareSpeechFundingPort({ paid, previewSecret: "p".repeat(32), now: () => new Date(now) })
      .reserve(trx.executor, { identity, requestId: `sp_${now.getTime()}_${suffix.padEnd(16, "a")}`,
        policyRevision: "speech-1", modelId: "gpt-4o-transcribe", maximumCostMicrousd: 100 }));

  it("uses a zero-charge exact-machine reservation and enforces its request cap", async () => {
    const first = await reserve(preview, "previewone");
    const second = await reserve(preview, "previewtwo");
    expect(first).toMatchObject({ reservationId: expect.stringMatching(/^preview_speech_/), reservedMicrousd: 0 });
    expect(second.reservationId).not.toBe(first.reservationId);
    expect(paid.reserve).not.toHaveBeenCalled();
    await expect(reserve(preview, "previewthree")).rejects.toMatchObject({ code: "allowance_exhausted" });
    expect(await db.executor.selectFrom("preview_runtime_allocations")
      .select("speech_requests_used").executeTakeFirstOrThrow()).toEqual({ speech_requests_used: 2 });
  });

  it("keeps customer speech on the existing paid funding path", async () => {
    await expect(reserve(customer, "customerone")).resolves.toEqual({ reservationId: "paid-reservation", reservedMicrousd: 10 });
    expect(paid.reserve).toHaveBeenCalledOnce();
  });

  it("uses the bounded no-charge path for an owner-only Private Preview", async () => {
    const runtimeSlot = "pv-2383-deadbeef";
    await db.executor.updateTable("user_machines").set({
      handle: runtimeSlot,
      runtime_slot: runtimeSlot,
      provisioning_class: "private-preview",
      source_pr: 2383,
      confirmed_bundle_version: "preview",
    }).where("machine_id", "=", preview.machineId).execute();
    await db.executor.updateTable("preview_runtime_allocations").set({ runtime_slot: runtimeSlot })
      .where("machine_id", "=", preview.machineId).execute();

    const result = await reserve({ ...preview, runtimeSlot }, "privatepreview");
    expect(result).toMatchObject({ reservationId: expect.stringMatching(/^preview_speech_/), reservedMicrousd: 0 });
    expect(paid.reserve).not.toHaveBeenCalled();
  });

  it("enforces one active speech operation for the exact Preview runtime", async () => {
    const operations = createSpeechOperationsRepository({ db, now: () => new Date(now),
      maximumActiveOperations: 10, maximumActiveOperationsPerOwner: 10 });
    const admission = (suffix: string) => ({ identity: preview,
      requestId: `sp_${now.getTime()}_${suffix.padEnd(16, "a")}`,
      sourceKind: "dictation" as const, contentFingerprint: (suffix === "first" ? "a" : "b").repeat(64),
      policyRevision: "speech-1", adapterId: "openai-file", modelId: "gpt-4o-transcribe",
      audioDurationMs: 1000, maximumCostMicrousd: 10 });
    await operations.admit(admission("first"), async () => ({ reservationId: "preview_funding_1", reservedMicrousd: 0 }));
    await expect(operations.admit(admission("second"), async () => ({ reservationId: "preview_funding_2", reservedMicrousd: 0 })))
      .rejects.toBeInstanceOf(SpeechOperationRateLimitError);
  });

  it("reports the exact remaining Preview speech quota to the runtime", async () => {
    const service = {
      capabilities: () => ({ contractVersion: 1 as const, fileTranscription: { status: "ready" as const,
        dictation: { enabled: true as const, maxBytes: 1024, maxDurationMs: 1000, maxTranscriptChars: 1000,
          supportedMediaTypes: ["audio/wav" as const], languageHints: false }, ownerAudio: { enabled: false as const } } }),
      shutdown: async () => undefined,
    } as PlatformSpeechService;
    const routes = createSpeechRuntimeRoutes({ db, service, platformSecret: "x".repeat(32),
      previewRuntimeSecret: "p".repeat(32), now: () => new Date(now) });
    const app = new Hono().route("/:handle/speech", routes);
    const token = buildPlatformSpeechRuntimeVerificationToken({ handle: preview.runtimeSlot,
      machineId: preview.machineId, runtimeSlot: preview.runtimeSlot }, "p".repeat(32), 1);
    const response = await app.request(`/${preview.runtimeSlot}/speech/capabilities?runtimeSlot=${preview.runtimeSlot}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ previewQuota: {
      mode: "preview", requestLimit: 2, requestsUsed: 0, requestsRemaining: 2, maxConcurrency: 1,
    } });
  });

  it("denies Preview replay after epoch rotation or expiry and never falls back to owner credit", async () => {
    await db.executor.updateTable("user_machines").set({ runtime_token_epoch: 2 })
      .where("machine_id", "=", preview.machineId).execute();
    await expect(reserve(preview, "rotatedepoch")).rejects.toMatchObject({ code: "allowance_exhausted" });
    await db.executor.updateTable("user_machines").set({ runtime_token_epoch: 1 }).execute();
    await db.executor.updateTable("preview_runtime_allocations").set({ expires_at: now.toISOString() }).execute();
    await expect(reserve(preview, "expiredtoken")).rejects.toMatchObject({ code: "allowance_exhausted" });
    expect(paid.reserve).not.toHaveBeenCalled();
  });
});
