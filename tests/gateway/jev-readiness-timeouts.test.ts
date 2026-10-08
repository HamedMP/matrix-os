import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FUNDED_AI_READINESS_TIMEOUTS, JEV_MODEL_ID } from "@matrix-os/contracts";
import { loadFundedAiRuntimeConfig } from "../../packages/gateway/src/funded-ai-credential-manager.js";
import { createFundedAiRouteReadinessClient } from "../../packages/gateway/src/funded-ai-route-readiness-client.js";
import { createFundedAiReadinessReader } from "../../packages/gateway/src/funded-ai-readiness.js";
const now = new Date("2026-10-01T00:00:00.000Z");
const receipt = { contractVersion: 1 as const, globalRevision: 1, runtimeRevision: 1,
  checkedAt: now.toISOString(), staleAfter: "2026-10-01T00:00:30.000Z", readyModelIds: [JEV_MODEL_ID] };
const summary = { policy: { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [JEV_MODEL_ID],
  monthlyBudgetMicrousd: 100_000, checkedAt: now.toISOString(), staleAfter: receipt.staleAfter },
funding: { asOf: now.toISOString(), periodStart: now.toISOString(), monthlyBudgetMicrousd: 100_000,
  settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 100_000,
  addonBalanceMicrousd: 0, creditBalanceMicrousd: 100_000, remainingBalanceMicrousd: 100_000, remainingBudgetMicrousd: 100_000 },
chatAvailability: { contractVersion: 1 as const, asOf: now.toISOString(), eligibleBalanceMicrousd: 100_000, availableBalanceMicrousd: 100_000 } };
function config() { return loadFundedAiRuntimeConfig({ MATRIX_FUNDED_AI_ENABLED: "true", PLATFORM_INTERNAL_URL: "https://platform.example.test",
  MATRIX_FUNDED_AI_RELAY_URL: "https://relay.example.test", MATRIX_FUNDED_AI_RUNTIME_TOKEN: "t".repeat(64),
  MATRIX_HANDLE: "fixture", MATRIX_CLERK_USER_ID: "owner_fixture", MATRIX_MACHINE_ID: "machine_fixture", MATRIX_RUNTIME_SLOT: "primary" })!; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Readiness deadline", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("uses strictly nested Jev budgets without changing five-second credential issuance", () => {
  const budget = FUNDED_AI_READINESS_TIMEOUTS;
  expect(budget.jevProbeMs).toBe(20_000);
  expect(budget.jevRouteMs).toBe(24_000);
  expect(budget.jevGatewayRequestMs).toBe(25_000);
  expect(budget.jevObservationMs).toBe(26_000);
  expect(config().requestTimeoutMs).toBe(5_000);
});
it("allows a cold Jev route to finish after five seconds", async () => {
  const client = createFundedAiRouteReadinessClient(config(), vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    setTimeout(() => resolve(Response.json(receipt)), 8_000);
  })) as typeof fetch);
  const result = client.getRouteReadiness({ modelId: JEV_MODEL_ID }).catch(error => error);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(await result).toEqual(receipt);
});
it("bounds a stalled Jev route request and preserves immediate caller cancellation", async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  const client = createFundedAiRouteReadinessClient(config(), fetchFn);
  const timed = client.getRouteReadiness({ modelId: JEV_MODEL_ID }).catch(error => error);
  let completed = false; void timed.then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(24_999); expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await timed).toMatchObject({ name: "TimeoutError" });
  const controller = new AbortController();
  const cancelled = client.getRouteReadiness({ modelId: JEV_MODEL_ID, signal: controller.signal }).catch(error => error);
  controller.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });
});
it("lets the scoped observation await settlement beyond the generic fourteen-second window", async () => {
  const reader = createFundedAiReadinessReader({ modelId: JEV_MODEL_ID, now: () => now,
    summary: { getFundingSummary: async () => summary }, routes: { getRouteReadiness: async () => new Promise(resolve => {
      setTimeout(() => resolve(receipt), 18_000);
    }) } });
  const result = reader.read();
  await vi.advanceTimersByTimeAsync(18_000);
  expect(await result).toMatchObject({ readiness: { state: "ready" }, allowedModelIds: [JEV_MODEL_ID] });
});
it("aborts an overdue scoped observation and ignores late readiness", async () => {
  const late = Promise.withResolvers<typeof receipt>(); let observed: AbortSignal | undefined;
  const reader = createFundedAiReadinessReader({ modelId: JEV_MODEL_ID, now: () => now,
    summary: { getFundingSummary: async () => summary }, routes: { getRouteReadiness: async options => {
      observed = options?.signal; return late.promise;
    } } });
  const result = reader.read();
  let complete = false; void result.then(() => { complete = true; });
  await vi.advanceTimersByTimeAsync(25_999); expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ readiness: { state: "unavailable" } });
  expect(observed?.aborted).toBe(true);
  late.resolve(receipt);
});
