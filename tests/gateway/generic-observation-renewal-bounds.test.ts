import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalNativeHarnessCatalogReader } from "../../packages/gateway/src/ai-providers/native-harness-canonical-projection.js";
import type { GenericHarnessModelCatalog } from "../../packages/gateway/src/ai-providers/generic-harness-model-catalog.js";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";

afterEach(() => vi.useRealTimers());
const start = Date.parse("2026-10-11T00:00:00Z");
function fixture(): GenericHarnessModelCatalog {
  return {
    providers: [{ id: "native", displayName: "Native", models: [{ id: "native:model", displayName: "Model", enabled: true }] }],
    accessSources: [{ id: "harness_pi_native", kind: "harness_profile", harness: "pi", providerId: "native", accountId: null,
      displayName: "Pi", fundingKind: "owner_account", eligibleModelIds: ["native:model"],
      readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
      localObservation: { state: "present_unverified", checkedAt: new Date(start).toISOString(), staleAfter: new Date(start + 5_000).toISOString() },
      usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: null } }],
    nativeDefaults: { pi: "native:model" }, failures: [],
  };
}

it.each(["error", "timeout", "abort"] as const)("coding observation renewal fails closed on %s without changing timestamps", async mode => {
  vi.useFakeTimers();
  let clock = start;
  const renewObservations = vi.fn(async () => {
    if (mode === "error") throw new Error("Synthetic metadata failure");
    return await new Promise<GenericHarnessModelCatalog>(() => undefined);
  });
  const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog: async () => fixture(), renewObservations }, { now: () => new Date(clock) });
  const original = await reader(false);
  clock += 6_001;
  const controller = new AbortController();
  const request = reader.renewStale(original, { deadline: clock + 2_000, signal: controller.signal });
  if (mode === "abort") {
    const rejected = expect(request).rejects.toThrow("Synthetic cancellation");
    controller.abort(new Error("Synthetic cancellation"));
    await rejected;
  } else {
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(1_001);
    expect(await request).toBe(original);
  }
  expect(renewObservations).toHaveBeenCalledOnce();
  expect(original.profiles[0]?.localObservation.staleAfter).toBe(new Date(start + 5_000).toISOString());
});

it("observes coding metadata after slow Hermes renewal so a second sibling cannot consume its TTL", async () => {
  let clock = start;
  const held = Promise.withResolvers<ReturnType<typeof normalizeHermesRuntimeSnapshot>>();
  const started = Promise.withResolvers<void>();
  const hermesSnapshot = () => normalizeHermesRuntimeSnapshot({ observedAt: clock,
    status: { gateway_running: false }, options: { provider: "openrouter", model: "native-model",
      providers: [{ slug: "openrouter", authenticated: true, is_user_defined: false, auth_type: "api_key", models: ["native-model"] }] } });
  const source = vi.fn().mockImplementationOnce(async () => hermesSnapshot()).mockImplementation(() => { started.resolve(); return held.promise; });
  const renewObservations = vi.fn(async () => {
    const value = fixture();
    value.accessSources[0]!.localObservation = { state: "present_unverified", checkedAt: new Date(clock).toISOString(), staleAfter: new Date(clock + 5_000).toISOString() };
    return value;
  });
  const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog: async () => fixture(), renewObservations },
    { now: () => new Date(clock), hermesRuntimeSource: source });
  const original = await reader(false);
  clock += 6_001;
  const request = reader.renewStale(original, { deadline: start + 13_000 });
  await started.promise;
  clock += 6_000;
  held.resolve(hermesSnapshot());
  const result = await request;
  expect(Date.parse(result.profiles.find(profile => profile.harness === "pi")!.localObservation.staleAfter!)).toBeGreaterThan(clock);
  expect(renewObservations).toHaveBeenCalledOnce();
});

it.each([50, 2_000])("rejects late metadata before a delayed timer callback with %ims scope remaining", async remaining => {
  vi.useFakeTimers();
  let clock = start;
  const held = Promise.withResolvers<GenericHarnessModelCatalog>();
  const started = Promise.withResolvers<void>();
  const renewObservations = vi.fn(() => { started.resolve(); return held.promise; });
  const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog: async () => fixture(), renewObservations },
    { now: () => new Date(clock) });
  const original = await reader(false);
  clock += 6_001;
  const deadline = clock + remaining;
  const renewalDeadline = clock + Math.min(1_000, remaining);
  const request = reader.renewStale(original, { deadline });
  await started.promise;
  // Wall-clock passes the budget while the timeout callback is still queued.
  // Resolving the metadata promise first reproduces event-loop timer lateness.
  clock = renewalDeadline + 1;
  const late = fixture();
  late.accessSources[0]!.localObservation = { state: "present_unverified", checkedAt: new Date(clock).toISOString(),
    staleAfter: new Date(clock + 5_000).toISOString() };
  held.resolve(late);
  expect(await request).toBe(original);
  expect(original.profiles[0]!.localObservation.checkedAt).toBe(new Date(start).toISOString());
  expect(vi.getTimerCount()).toBe(0);
});
