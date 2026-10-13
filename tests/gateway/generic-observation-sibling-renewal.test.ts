import { afterEach, expect, it, vi } from "vitest";
import { createGenericHarnessModelCatalogReader } from "../../packages/gateway/src/ai-providers/generic-harness-model-catalog.js";
import { createCanonicalNativeHarnessCatalogReader } from "../../packages/gateway/src/ai-providers/native-harness-canonical-projection.js";

const metadata = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../packages/gateway/src/ai-providers/generic-native-profile-observation.js", () => ({
  createGenericNativeProfileObserver: () => metadata.read,
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); metadata.read.mockReset(); });

it.each((["pi", "opencode"] as const).flatMap(slow => [
  { slow, remaining: 2_000 }, { slow, remaining: 50 },
]))("retains the completed sibling when $slow metadata stalls with $remaining ms remaining", async ({ slow, remaining }) => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-13T00:00:00Z");
  let clock = start;
  let renewing = false;
  const held = Promise.withResolvers<{ defaultModel: string; observations: Record<string, unknown> }>();
  const fastStarted = Promise.withResolvers<void>();
  const fast = slow === "pi" ? "opencode" : "pi";
  const observed = (at: number) => ({ defaultModel: "native:working-model", observations: { native: {
    state: "present_unverified", checkedAt: new Date(at).toISOString(), staleAfter: new Date(at + 5_000).toISOString(),
  } } });
  metadata.read.mockImplementation(async (input: { harness: string; now: Date }) => {
    if (renewing && input.harness === slow) return held.promise;
    if (renewing && input.harness === fast) fastStarted.resolve();
    return observed(+input.now);
  });
  const run = vi.fn(async (command: string) => ({ stdout: command === "opencode"
    ? "native/working-model"
    : "provider model context max-out thinking images\nnative working-model 200000 32000 yes no", stderr: "" }));
  const generic = createGenericHarnessModelCatalogReader({ homePath: "/synthetic-owner", enabledHarnesses: ["pi", "opencode"],
    run, now: () => new Date(clock) });
  const reader = createCanonicalNativeHarnessCatalogReader(generic, { now: () => new Date(clock) });
  const original = await reader(false);
  expect(original.profiles.map(profile => profile.harness)).toEqual(["pi", "opencode"]);
  clock += 6_001;
  renewing = true;
  metadata.read.mockClear();
  const request = reader.renewStale(original, { deadline: clock + remaining });
  await fastStarted.promise;
  await vi.advanceTimersByTimeAsync(0);
  const acceptedAt = clock;
  clock += Math.min(remaining, 1_000) + 1;
  await vi.advanceTimersByTimeAsync(Math.min(remaining, 1_000) + 1);
  const result = await request;
  expect(result.profiles.find(profile => profile.harness === fast)?.localObservation).toEqual(observed(acceptedAt).observations.native);
  expect(result.profiles.find(profile => profile.harness === slow)?.localObservation).toEqual(observed(start).observations.native);
  expect(result.failures).toEqual(original.failures);
  expect(metadata.read.mock.calls.map(([input]) => input.harness).sort()).toEqual(["opencode", "pi"]);
  expect(run).toHaveBeenCalledTimes(2);
  // Late completion cannot mutate the returned catalog or borrow a fresh TTL.
  const saved = JSON.stringify(result);
  held.resolve(observed(clock));
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(result)).toBe(saved);
  expect(vi.getTimerCount()).toBe(0);
});
