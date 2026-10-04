import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FundedAiRouteReadinessReceiptSchema } from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import type { FundedModelProbeService } from "../../packages/platform/src/ai-funded-model-probes.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const now = "2026-08-30T20:00:00.000Z";
const modelId = "anthropic/claude-sonnet-5";
const platformSecret = "platform-secret-for-tests-123456789";
const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" };
function bearerFor(handle: string): string {
  return buildPlatformRuntimeVerificationToken({ handle, machineId: identity.machineId, runtimeSlot: identity.runtimeSlot }, platformSecret);
}

describe("funded model receipt observation lifetimes", () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "alice", runtimeSlot: identity.runtimeSlot,
      status: "running", imageVersion: "v1", provisionedAt: "2026-08-30T19:00:00.000Z", activationState: "authorized" });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.restoreAllMocks(); });
  async function createTestApp(options: { routeProbes: FundedModelProbeService; allowedModelIds?: string[]; now: () => Date }) {
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "credential-hash-secret-for-tests-123", now: options.now });
    const allowedModelIds = options.allowedModelIds ?? [modelId];
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds });
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds, expiresAt: null, monthlyBudgetMicrousd: 1_000 });
    await repository.grantCredit({ entryId: "grant_receipt", identity, kind: "promotional_grant", amountMicrousd: 1_000, sourceReference: "receipt-fixture" });
    const app = new Hono().route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({ db, platformSecret, repository, now: options.now, routeProbes: options.routeProbes }));
    return { app, repository };
  }
  it("keeps a slow healthy model ready after an unrelated cached failure expires", async () => {
    const glm = "@cf/zai-org/glm-5.3-flash";
    let current = Date.parse(now);
    const probe = vi.fn(async (model: string) => {
      if (model === glm) return { ready: false, checkedAt: now, staleAfter: "2026-08-30T20:00:05.000Z" };
      // Simulate a healthy response taking 6s, within the shared 12s deadline.
      await Promise.resolve();
      current += 6_000;
      return { ready: true, checkedAt: new Date(current).toISOString(), staleAfter: "2026-08-30T20:00:30.000Z" };
    });
    const { app } = await createTestApp({ routeProbes: { probe }, allowedModelIds: [glm, modelId], now: () => new Date(current) });
    const response = await app.request("/internal/containers/alice/ai/route-readiness?runtimeSlot=primary", {
      method: "POST", headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(200);
    expect(FundedAiRouteReadinessReceiptSchema.parse(await response.json())).toMatchObject({
      readyModelIds: [modelId], checkedAt: "2026-08-30T20:00:06.000Z", staleAfter: "2026-08-30T20:00:30.000Z",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("never puts stale healthy observations in a ready receipt", async () => {
    let current = Date.parse(now);
    const probe = vi.fn(async () => {
      current += 6_000;
      return { ready: true, checkedAt: now, staleAfter: "2026-08-30T20:00:05.000Z" };
    });
    const { app } = await createTestApp({ routeProbes: { probe }, now: () => new Date(current) });
    const response = await app.request("/internal/containers/alice/ai/route-readiness?runtimeSlot=primary", {
      method: "POST", headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(200);
    expect(FundedAiRouteReadinessReceiptSchema.parse(await response.json()).readyModelIds).toEqual([]);
  });

  it("fails closed when the caller cancels after a healthy probe", async () => {
    const abort = new AbortController();
    const probe = vi.fn(async () => {
      abort.abort();
      return { ready: true, checkedAt: now, staleAfter: "2026-08-30T20:00:30.000Z" };
    });
    const { app } = await createTestApp({ routeProbes: { probe }, now: () => new Date(now) });
    const response = await app.request("/internal/containers/alice/ai/route-readiness?runtimeSlot=primary", {
      method: "POST", signal: abort.signal,
      headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  it("rereads budget policy after healthy observations and does not authorize exhausted funding", async () => {
    let repository!: ReturnType<typeof createAiFundedPolicyRepository>;
    const probe = vi.fn(async () => {
      await repository.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true, allowedModelIds: [modelId], expiresAt: null, monthlyBudgetMicrousd: 0 });
      return { ready: true, checkedAt: now, staleAfter: "2026-08-30T20:00:30.000Z" };
    });
    const created = await createTestApp({ routeProbes: { probe }, now: () => new Date(now) });
    repository = created.repository;
    const response = await created.app.request("/internal/containers/alice/ai/route-readiness?runtimeSlot=primary", {
      method: "POST", headers: { authorization: `Bearer ${bearerFor("alice")}`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(200);
    expect(FundedAiRouteReadinessReceiptSchema.parse(await response.json()).readyModelIds).toEqual([]);
  });

});
