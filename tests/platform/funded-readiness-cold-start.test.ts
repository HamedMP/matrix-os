import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { createFundedModelProbeService } from "../../packages/platform/src/ai-funded-model-probes.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { loadFundedAiRuntimeConfig } from "../../packages/gateway/src/funded-ai-credential-manager.js";
import { createFundedAiFundingSummaryClient } from "../../packages/gateway/src/funded-ai-funding-summary-client.js";
import { createFundedAiRouteReadinessClient } from "../../packages/gateway/src/funded-ai-route-readiness-client.js";
import { createFundedAiReadinessReader } from "../../packages/gateway/src/funded-ai-readiness.js";
import { isAiCreditCheckoutRouteHealthy } from "../../packages/platform/src/ai-credit-checkout-readiness.js";

const model = "@cf/zai-org/glm-5.3-flash";
const identity = { ownerId: "cold_owner", machineId: "cold_machine", runtimeSlot: "primary" };
const platformSecret = "p".repeat(32);
let db: PlatformDB;
beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await destroyTestPlatformDb(db); });

async function fixture(delayMs: number) {
  const now = () => new Date();
  await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
    handle: "cold-runtime", runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "fixture",
    activationState: "authorized", provisionedAt: now().toISOString() });
  const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now });
  await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
  await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [model],
    monthlyBudgetMicrousd: 100000, expiresAt: null });
  await repository.grantCredit({ identity, entryId: "cold-fixture-credit", kind: "promotional_grant",
    amountMicrousd: 100000, sourceReference: "local-test" });
  vi.useFakeTimers();
  // Native AbortSignal.timeout has its own clock. Preserve cancellation while
  // putting every timeout in this simulated cold-start observation on one clock.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  const relayResolved = vi.fn();
  const relayFetch = vi.fn<typeof fetch>((_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      relayResolved();
      resolve(Response.json({ ready: true, priceValidThrough: new Date(Date.now() + 60000).toISOString() }));
    }, delayMs);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  }));
  const probes = createFundedModelProbeService({ db, relayBaseUrl: "https://relay.example.test",
    relayControlToken: "c".repeat(32), dailyLimit: 1, minuteLimit: 1, fetchFn: relayFetch, now });
  const app = new Hono().route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({ db,
    platformSecret, repository, routeProbes: probes, now, promotionalGrant: { enabled: false } }));
  const config = loadFundedAiRuntimeConfig({ MATRIX_FUNDED_AI_ENABLED: "true",
    MATRIX_FUNDED_AI_RELAY_URL: "https://relay.example.test", MATRIX_FUNDED_AI_PLATFORM_URL: "https://platform.example.test",
    MATRIX_FUNDED_AI_RUNTIME_TOKEN: buildPlatformRuntimeVerificationToken({ handle: "cold-runtime",
      machineId: identity.machineId, runtimeSlot: identity.runtimeSlot }, platformSecret),
    MATRIX_HANDLE: "cold-runtime", MATRIX_CLERK_USER_ID: identity.ownerId,
    MATRIX_MACHINE_ID: identity.machineId, MATRIX_RUNTIME_SLOT: identity.runtimeSlot })!;
  const platformFetch = ((url, init) => app.request(String(url), init)) as typeof fetch;
  const reader = createFundedAiReadinessReader({ summary: createFundedAiFundingSummaryClient(config, { fetchFn: platformFetch }),
    routes: createFundedAiRouteReadinessClient(config, platformFetch), now });
  return { reader, repository, relayFetch, relayResolved, config, probes };
}

async function waitForProbe(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
  await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce(), { interval: 1 });
}

async function expectOneUnspentProbe() {
  expect(await db.executor.selectFrom("ai_funded_model_probe_budget").select(["day_used", "minute_used"]).execute())
    .toEqual([{ day_used: 1, minute_used: 1 }]);
  expect(await db.executor.selectFrom("ai_funded_usage_reservations").select("reservation_id").execute()).toEqual([]);
  const balance = await db.executor.selectFrom("ai_funded_runtime_balances").select(["credit_balance_microusd",
    "reserved_microusd", "month_spent_microusd"]).executeTakeFirstOrThrow();
  expect(balance).toEqual({ credit_balance_microusd: 100000, reserved_microusd: 0, month_spent_microusd: 0 });
}

describe("cold funded relay readiness", () => {
  it("allows credit checkout after a seven-second cold relay and a fresh funding reread", async () => {
    const f = await fixture(7000);
    const result = isAiCreditCheckoutRouteHealthy({ repository: f.repository, identity, modelProbes: f.probes });
    await waitForProbe(f.relayFetch);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await result).toBe(true);
    expect(f.relayResolved).toHaveBeenCalledOnce();
    await expectOneUnspentProbe();
  });

  it("rejects checkout when owner policy is revoked while the cold relay starts", async () => {
    const f = await fixture(7000);
    const result = isAiCreditCheckoutRouteHealthy({ repository: f.repository, identity, modelProbes: f.probes });
    await waitForProbe(f.relayFetch);
    await vi.advanceTimersByTimeAsync(3000);
    await f.repository.setRuntimePolicy({ identity, expectedRevision: 1, enabled: false, allowedModelIds: [model],
      monthlyBudgetMicrousd: 100000, expiresAt: null });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBe(false);
    expect(f.relayResolved).toHaveBeenCalledOnce();
    await expectOneUnspentProbe();
  });

  it("aborts a stalled checkout probe and keeps its single admission counted", async () => {
    const f = await fixture(20000);
    const result = isAiCreditCheckoutRouteHealthy({ repository: f.repository, identity, modelProbes: f.probes });
    await waitForProbe(f.relayFetch);
    await vi.advanceTimersByTimeAsync(10001);
    expect(await result).toBe(false);
    expect(f.relayFetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(f.relayResolved).not.toHaveBeenCalled();
    await expectOneUnspentProbe();
  });

  it("waits for a seven-second cold relay through Platform and the default Gateway client", async () => {
    const f = await fixture(7000);
    expect(f.config.requestTimeoutMs).toBe(5000); // credential/funding calls retain their existing bound
    const result = f.reader.read();
    await waitForProbe(f.relayFetch);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await result).toMatchObject({ readiness: { state: "ready" }, allowedModelIds: [model] });
    expect(f.relayFetch).toHaveBeenCalledOnce();
    await expectOneUnspentProbe();
  });

  it("rechecks revoked owner policy after a cold relay succeeds", async () => {
    const f = await fixture(7000);
    const result = f.reader.read();
    await waitForProbe(f.relayFetch);
    await vi.advanceTimersByTimeAsync(3000);
    await f.repository.setRuntimePolicy({ identity, expectedRevision: 1, enabled: false, allowedModelIds: [model],
      monthlyBudgetMicrousd: 100000, expiresAt: null });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toMatchObject({ readiness: { state: "unavailable" }, allowedModelIds: [] });
    expect(f.relayResolved).toHaveBeenCalledOnce();
    await expectOneUnspentProbe();
  });

  it("aborts a relay beyond the bounded window without retrying or refunding its counted attempt", async () => {
    const f = await fixture(20000);
    const result = f.reader.read();
    await waitForProbe(f.relayFetch);
    await vi.advanceTimersByTimeAsync(10001);
    expect(await result).toMatchObject({ readiness: { state: "unavailable" }, allowedModelIds: [] });
    expect(f.relayFetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(f.relayFetch).toHaveBeenCalledOnce();
    await expectOneUnspentProbe();
  });
});
