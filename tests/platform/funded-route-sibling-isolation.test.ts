import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { FUNDED_AI_READINESS_TIMEOUTS, FundedAiRouteReadinessReceiptSchema } from "@matrix-os/contracts";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const start = "2026-10-11T00:00:00.000Z";
const models = ["@cf/zai-org/glm-5.3-flash", "anthropic/claude-sonnet-5"] as const;
const secret = "synthetic-platform-secret-123456789";
const identity = { ownerId: "synthetic_owner", machineId: "synthetic_machine", runtimeSlot: "primary" as const };
let db: PlatformDB | undefined;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await destroyTestPlatformDb(db); db = undefined; });

async function fixture() {
  ({ db } = await createTestPlatformDb());
  await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "fixture",
    runtimeSlot: "primary", status: "running", imageVersion: "synthetic", activationState: "authorized", provisionedAt: start });
  const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "synthetic-hash-secret-1234567890123456789", now: () => new Date(start) });
  await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [...models] });
  await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [...models], expiresAt: null, monthlyBudgetMicrousd: 1_000 });
  await repository.grantCredit({ entryId: "synthetic_fixture_grant", identity, kind: "promotional_grant", amountMicrousd: 1_000, sourceReference: "synthetic-tests-only" });
  const current = await repository.getCheckoutFundingSummary(identity, Date.now() + 6_000);
  // Keep real route authentication/database bindings, but isolate the probe
  // deadline from SQL scheduling. Every final policy read remains observable.
  const read = vi.spyOn(repository, "getCheckoutFundingSummary").mockImplementation(async () => structuredClone(current));
  return { repository, current, read };
}

const cases = models.flatMap(healthy => (["error", "stall"] as const).map(sibling => ({ healthy, sibling })));
it.each(cases)("retains $healthy when its sibling $sibling without borrowing sibling health", async ({ healthy, sibling }) => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const probe = vi.fn(async (model: string) => {
    started.resolve();
    if (model === healthy) return { ready: true, checkedAt: start, staleAfter: new Date(Date.parse(start) + 30_000).toISOString() };
    if (sibling === "error") throw new Error("Synthetic sibling timeout");
    return await new Promise<never>(() => undefined);
  });
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const app = new Hono().route("/runtime/:handle", createAiFundedRuntimeRoutes({ db: db!, platformSecret: secret, repository: f.repository,
    routeProbes: { probe }, now: () => new Date() }));
  const token = buildPlatformRuntimeVerificationToken({ handle: "fixture", machineId: identity.machineId, runtimeSlot: "primary" }, secret);
  const request = app.request("/runtime/fixture/route-readiness?runtimeSlot=primary", { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  await started.promise;
  if (sibling === "stall") await vi.advanceTimersByTimeAsync(FUNDED_AI_READINESS_TIMEOUTS.platformRouteMs + 1);
  const response = await request;
  expect(response.status).toBe(200);
  expect(FundedAiRouteReadinessReceiptSchema.parse(await response.json()).readyModelIds).toEqual([healthy]);
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenCalledTimes(2);
  for (const call of f.read.mock.calls) expect(call[0]).toEqual(identity);
});

it.each(["policy", "budget", "stale_health", "all_stalled", "cancel"] as const)("does not admit a model after $0", async reason => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  f.read.mockImplementationOnce(async () => structuredClone(f.current)).mockImplementation(async () => {
    const latest = structuredClone(f.current);
    if (reason === "policy") latest.policy.runtimeRevision += 1;
    if (reason === "budget") latest.funding.remainingBudgetMicrousd = 0;
    return latest;
  });
  const probe = vi.fn(async (model: string) => {
    started.resolve();
    if (reason === "all_stalled" || reason === "cancel" && model === models[1]) return await new Promise<never>(() => undefined);
    return { ready: true, checkedAt: start, staleAfter: new Date(Date.parse(start) + (reason === "stale_health" ? 0 : 30_000)).toISOString() };
  });
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const controller = new AbortController();
  const app = new Hono().route("/runtime/:handle", createAiFundedRuntimeRoutes({ db: db!, platformSecret: secret,
    repository: f.repository, routeProbes: { probe }, now: () => new Date() }));
  const token = buildPlatformRuntimeVerificationToken({ handle: "fixture", machineId: identity.machineId, runtimeSlot: "primary" }, secret);
  const request = app.request("/runtime/fixture/route-readiness?runtimeSlot=primary", { method: "POST", body: "{}", signal: controller.signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  await started.promise;
  if (reason === "all_stalled") await vi.advanceTimersByTimeAsync(FUNDED_AI_READINESS_TIMEOUTS.platformRouteMs + 1);
  if (reason === "cancel") controller.abort();
  const response = await request;
  if (reason === "all_stalled" || reason === "cancel") expect(response.status).toBe(503);
  else {
    expect(response.status).toBe(200);
    expect(FundedAiRouteReadinessReceiptSchema.parse(await response.json()).readyModelIds).toEqual([]);
    expect(f.read).toHaveBeenCalledTimes(2);
  }
});

it("reserves 1.5 seconds for a delayed final funding read within the original deadline", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  let finalReadAt: number | undefined;
  f.read.mockImplementationOnce(async () => structuredClone(f.current)).mockImplementation(async () => {
    finalReadAt = Date.now();
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    return structuredClone(f.current);
  });
  const probe = vi.fn(async (model: string) => {
    started.resolve();
    if (model === models[1]) return await new Promise<never>(() => undefined);
    return { ready: true, checkedAt: start, staleAfter: new Date(Date.parse(start) + 30_000).toISOString() };
  });
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const app = new Hono().route("/runtime/:handle", createAiFundedRuntimeRoutes({ db: db!, platformSecret: secret,
    repository: f.repository, routeProbes: { probe }, now: () => new Date() }));
  const token = buildPlatformRuntimeVerificationToken({ handle: "fixture", machineId: identity.machineId, runtimeSlot: "primary" }, secret);
  let completed = false;
  const request = app.request("/runtime/fixture/route-readiness?runtimeSlot=primary", { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }).then(response => { completed = true; return response; });
  await started.promise;
  const observationMs = FUNDED_AI_READINESS_TIMEOUTS.platformRouteMs - 1_500;
  await vi.advanceTimersByTimeAsync(observationMs);
  expect(finalReadAt).toBe(Date.parse(start) + observationMs);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const response = await request;
  expect(response.status).toBe(200);
  expect(FundedAiRouteReadinessReceiptSchema.parse(await response.json()).readyModelIds).toEqual([models[0]]);
  expect(Date.now()).toBe(Date.parse(start) + observationMs + 1_000);
  expect(Date.now()).toBeLessThan(Date.parse(start) + FUNDED_AI_READINESS_TIMEOUTS.platformRouteMs);
  expect(f.read).toHaveBeenCalledTimes(2);
});
