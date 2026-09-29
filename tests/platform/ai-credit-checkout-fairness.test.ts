import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAiCreditCheckoutRouteHealthy } from "../../packages/platform/src/ai-credit-checkout-readiness.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createFundedModelProbeService, FUNDED_PROBE_MODELS } from "../../packages/platform/src/ai-funded-model-probes.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { createBillingRoutes, type StripeBillingClient } from "../../packages/platform/src/billing-routes.js";

const identity = { ownerId: "fair_owner", machineId: "fair_machine", runtimeSlot: "primary" };
const [glm, sonnet] = FUNDED_PROBE_MODELS;
let db: PlatformDB;

beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await destroyTestPlatformDb(db);
});

async function fixture(responses: Record<string, { delayMs: number; ready: boolean; priceTtlMs?: number }>, limit = 10) {
  const now = () => new Date();
  await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
    handle: "fair-runtime", runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "fixture",
    activationState: "authorized", provisionedAt: now().toISOString() });
  const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now });
  await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [glm, sonnet] });
  await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
    allowedModelIds: [glm, sonnet], monthlyBudgetMicrousd: 100_000, expiresAt: null });
  await repository.grantCredit({ identity, entryId: "fair-fixture-credit", kind: "promotional_grant",
    amountMicrousd: 100_000, sourceReference: "local-test" });
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  const fetchFn = vi.fn<typeof fetch>((url, init) => new Promise((resolve, reject) => {
    const model = new URL(String(url)).searchParams.get("model")!;
    const response = responses[model]!;
    const timer = setTimeout(() => {
      resolve(response.ready
        ? Response.json({ ready: true, priceValidThrough: new Date(Date.now() + (response.priceTtlMs ?? 60_000)).toISOString() })
        : new Response(null, { status: 503 }));
    }, response.delayMs);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(init.signal?.reason);
    }, { once: true });
  }));
  const probes = createFundedModelProbeService({ db, relayBaseUrl: "https://relay.example.test",
    relayControlToken: "c".repeat(32), dailyLimit: limit, minuteLimit: limit, fetchFn, now });
  const checkout = () => isAiCreditCheckoutRouteHealthy({ repository, identity, modelProbes: probes });
  return { repository, fetchFn, probes, checkout };
}

async function expectCountedUnspentProbes(count: number) {
  expect(await db.executor.selectFrom("ai_funded_model_probe_budget").select(["day_used", "minute_used"]).execute())
    .toEqual([{ day_used: count, minute_used: count }]);
  expect(await db.executor.selectFrom("ai_funded_usage_reservations").select("reservation_id").execute()).toEqual([]);
  expect(await db.executor.selectFrom("ai_funded_runtime_balances").select(["credit_balance_microusd",
    "reserved_microusd", "month_spent_microusd"]).executeTakeFirstOrThrow())
    .toEqual({ credit_balance_microusd: 100_000, reserved_microusd: 0, month_spent_microusd: 0 });
}

describe("multi-model credit checkout readiness", () => {
  it("permits checkout through a healthy later model despite a slow failed first model", async () => {
    const f = await fixture({ [glm]: { delayMs: 10_000, ready: false },
      [sonnet]: { delayMs: 4_000, ready: true } });
    const result = f.checkout();
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalled(), { interval: 1 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toBe(true);
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
    await expectCountedUnspentProbes(2);
  });

  it("cancels checkout probes when the HTTP caller disconnects without creating payment", async () => {
    const f = await fixture({ [glm]: { delayMs: 20_000, ready: true },
      [sonnet]: { delayMs: 20_000, ready: true } });
    const stripe: StripeBillingClient = { apiTimeoutMs: 10_000, createCheckoutSession: vi.fn(),
      createAiCreditCheckoutSession: vi.fn(), retrieveCheckoutSession: vi.fn(),
      createPortalSession: vi.fn(), constructWebhookEvent: vi.fn() };
    const app = new Hono().route("/billing", createBillingRoutes({ db, stripe,
      fundedAiRepository: f.repository, fundedModelProbes: f.probes,
      resolveClerkUserId: async () => identity.ownerId,
      env: { MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "true", STRIPE_SECRET_KEY: "configured",
        STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_AI_CREDIT_USD_5: "price_ai_5",
        STRIPE_PRICE_AI_CREDIT_USD_10: "price_ai_10", STRIPE_PRICE_AI_CREDIT_USD_25: "price_ai_25" } }));
    const controller = new AbortController();
    const result = app.request("/billing/ai-credit/checkout", { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageId: "usd_5", runtimeSlot: "primary", requestId: crypto.randomUUID() }) });
    try {
      await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2), { interval: 1 });
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetchFn.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect((await result).status).toBe(503);
      expect(stripe.createAiCreditCheckoutSession).not.toHaveBeenCalled();
      await expectCountedUnspentProbes(2);
    } finally {
      await vi.advanceTimersByTimeAsync(12_000);
      await result;
    }
  });

  it("rejects model evidence that expires during the final funding reread", async () => {
    const f = await fixture({ [glm]: { delayMs: 20_000, ready: false },
      [sonnet]: { delayMs: 4_000, ready: true, priceTtlMs: 1_000 } });
    let reads = 0;
    const repository = { getCheckoutFundingSummary: async (...args: Parameters<typeof f.repository.getCheckoutFundingSummary>) => {
      if (++reads === 2) await new Promise(resolve => setTimeout(resolve, 6_000));
      return f.repository.getCheckoutFundingSummary(...args);
    } };
    const result = isAiCreditCheckoutRouteHealthy({ repository, identity, modelProbes: f.probes });
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2), { interval: 1 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toBe(false);
  });

  it("rejects checkout when every eligible model is unavailable and retains both admissions", async () => {
    const f = await fixture({ [glm]: { delayMs: 1_000, ready: false },
      [sonnet]: { delayMs: 2_000, ready: false } });
    const result = f.checkout();
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2), { interval: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe(false);
    await expectCountedUnspentProbes(2);
  });

  it("aborts both probes at the overall checkout deadline without refunding admissions", async () => {
    const f = await fixture({ [glm]: { delayMs: 20_000, ready: true },
      [sonnet]: { delayMs: 20_000, ready: true } });
    const result = isAiCreditCheckoutRouteHealthy({ repository: f.repository, identity,
      modelProbes: f.probes, deadlineMs: 2_000 });
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2), { interval: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe(false);
    expect(f.fetchFn.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await expectCountedUnspentProbes(2);
  });

  it("fails closed when owner policy is revoked while parallel probes are pending", async () => {
    const f = await fixture({ [glm]: { delayMs: 10_000, ready: false },
      [sonnet]: { delayMs: 4_000, ready: true } });
    const result = f.checkout();
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2), { interval: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await f.repository.setRuntimePolicy({ identity, expectedRevision: 1, enabled: false,
      allowedModelIds: [glm, sonnet], monthlyBudgetMicrousd: 100_000, expiresAt: null });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toBe(false);
    await expectCountedUnspentProbes(2);
  });

  it("reuses cached model health while rereading owner policy without new admissions", async () => {
    const f = await fixture({ [glm]: { delayMs: 100, ready: true },
      [sonnet]: { delayMs: 200, ready: true } });
    const warm = Promise.all(FUNDED_PROBE_MODELS.map(model => f.probes.probe(model)));
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2), { interval: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect((await warm).every(result => result.ready)).toBe(true);
    expect(await f.checkout()).toBe(true);
    await f.repository.setRuntimePolicy({ identity, expectedRevision: 1, enabled: false,
      allowedModelIds: [glm, sonnet], monthlyBudgetMicrousd: 100_000, expiresAt: null });
    expect(await f.checkout()).toBe(false);
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
    await expectCountedUnspentProbes(2);
  });

  it("does not cancel a shared probe needed by another caller when checkout finds an alternative", async () => {
    const f = await fixture({ [glm]: { delayMs: 8_000, ready: true },
      [sonnet]: { delayMs: 4_000, ready: true } });
    const otherCaller = f.probes.probe(glm);
    const checkout = f.checkout();
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2), { interval: 1 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await checkout).toBe(true);
    const shared = f.fetchFn.mock.calls.find(([url]) => new URL(String(url)).searchParams.get("model") === glm)!;
    expect(shared[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await otherCaller).ready).toBe(true);
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
    await expectCountedUnspentProbes(2);
  });

  it("never exceeds the atomic operator budget even when both models start together", async () => {
    const f = await fixture({ [glm]: { delayMs: 1_000, ready: false },
      [sonnet]: { delayMs: 1_000, ready: false } }, 1);
    const result = f.checkout();
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledOnce(), { interval: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(false);
    expect(f.fetchFn).toHaveBeenCalledOnce();
    await expectCountedUnspentProbes(1);
  });
});
