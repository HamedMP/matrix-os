// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createDesktopQueryClient } from "../../desktop/src/renderer/src/lib/query-client";
import { ProviderCatalogCache } from "../../desktop/src/renderer/src/features/chat/provider-catalog-cache";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

it("recovers a transient Codex observation before the ordinary five-minute deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  try {
    const fixture = createCanonicalProviderCatalogFixture();
    const healthy = fixture;
    const unavailable = { ...healthy, instances: healthy.instances.map(instance => ({ ...instance, availability: "unavailable" as const, unavailabilityReason: "runtime_unavailable" as const, observationState: "checking" as const, models: instance.models.map(model => ({ ...model, availability: "unavailable" as const })), options: [], defaultSelection: undefined })) };
    let backend = healthy;
    const api = { get: vi.fn(async () => backend) };
    state.observe({ api, generation: 0, identityKey: "fixture-owner:main" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.getSnapshot().catalog?.instances[0]?.models.length).toBeGreaterThan(0);
    backend = unavailable;
    state.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.getSnapshot().catalog?.instances[0]).toMatchObject({ unavailabilityReason: "runtime_unavailable", observationState: "checking" });
    expect(state.getSnapshot().refreshError).toBeNull();
    backend = healthy; // Native probe recovers; cached response remains a successful read.
    await vi.advanceTimersByTimeAsync(4999);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(state.getSnapshot().catalog?.instances[0]?.observationState).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(state.getSnapshot().catalog?.instances[0]?.availability).toBe("available");
    expect(state.getSnapshot().catalog?.instances[0]?.observationState).toBeUndefined();
  } finally {
    state.clear();
    client.clear();
    vi.useRealTimers();
  }
});

it("caps short retries and cancels their timer on scope teardown", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  try {
    const base = createCanonicalProviderCatalogFixture();
    const checking = { ...base, instances: base.instances.map(instance => ({ ...instance, availability: "unavailable" as const, unavailabilityReason: "runtime_unavailable" as const, observationState: "checking" as const, models: instance.models.map(model => ({ ...model, availability: "unavailable" as const })), defaultSelection: undefined })) };
    const api = { get: vi.fn(async () => checking) };
    state.observe({ api, generation: 0, identityKey: "fixture-owner:main" });
    await vi.advanceTimersByTimeAsync(0);
    for (const [delay, reads] of [[5000, 2], [15000, 3], [30000, 4]]) {
      await vi.advanceTimersByTimeAsync(delay!);
      expect(api.get).toHaveBeenCalledTimes(reads!);
    }
    expect(state.getSnapshot().lastSuccessAt).toBeNull();
    await vi.advanceTimersByTimeAsync(299999);
    expect(api.get).toHaveBeenCalledTimes(4);
    state.clear();
    await vi.advanceTimersByTimeAsync(300001);
    expect(api.get).toHaveBeenCalledTimes(4);
  } finally { state.clear(); client.clear(); vi.useRealTimers(); }
});

it("does not retry a confirmed authentication failure as a temporary check", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  try {
    const base = createCanonicalProviderCatalogFixture();
    const signedOut = { ...base, instances: base.instances.map(instance => ({ ...instance, availability: "unavailable" as const, unavailabilityReason: "authentication_required" as const, models: [], defaultSelection: undefined })) };
    const api = { get: vi.fn(async () => signedOut) };
    state.observe({ api, generation: 0, identityKey: "fixture-owner:main" });
    await vi.advanceTimersByTimeAsync(299999);
    expect(api.get).toHaveBeenCalledOnce();
  } finally { state.clear(); client.clear(); vi.useRealTimers(); }
});
