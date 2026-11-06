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

function checkingCatalog() {
  const fixture = createCanonicalProviderCatalogFixture();
  return { ...fixture, instances: fixture.instances.map(instance => ({ ...instance,
    availability: "unavailable" as const, unavailabilityReason: "runtime_unavailable" as const,
    observationState: "checking" as const, defaultSelection: undefined,
    models: instance.models.map(model => ({ ...model, availability: "unavailable" as const })),
  })) };
}

it("continues with the fifteen-second checking retry after the five-second read fails", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0.99);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  const healthy = createCanonicalProviderCatalogFixture();
  const api = { get: vi.fn().mockResolvedValueOnce(checkingCatalog())
    .mockRejectedValueOnce(new Error("Temporary transport failure")).mockResolvedValue(healthy) };
  try {
    state.observe({ api, generation: 0, identityKey: "fixture-owner:main" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(state.getSnapshot()).toMatchObject({ lastSuccessAt: null, refreshing: false });
    expect(state.getSnapshot().refreshError).toBeTruthy();
    await vi.advanceTimersByTimeAsync(14999);
    expect(api.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(state.getSnapshot().catalog?.instances[0]?.availability).toBe("available");
    expect(state.getSnapshot().lastSuccessAt).toBe(Date.now());
    expect(state.getSnapshot().refreshError).toBeNull();
    await vi.advanceTimersByTimeAsync(299999);
    expect(api.get).toHaveBeenCalledTimes(3);
  } finally { state.clear(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers(); }
});

it("spends failed checking attempts within the short budget then uses ordinary cadence and cancels on clear", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0.99);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  const api = { get: vi.fn().mockResolvedValueOnce(checkingCatalog()).mockRejectedValue(new Error("Temporary transport failure")) };
  try {
    state.observe({ api, generation: 0, identityKey: "fixture-owner:main" });
    await vi.advanceTimersByTimeAsync(0);
    for (const [delay, reads] of [[5000, 2], [15000, 3], [30000, 4]]) {
      await vi.advanceTimersByTimeAsync(delay! - 1);
      expect(api.get).toHaveBeenCalledTimes(reads! - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.get).toHaveBeenCalledTimes(reads!);
    }
    expect(state.getSnapshot().lastSuccessAt).toBeNull();
    await vi.advanceTimersByTimeAsync(299999);
    expect(api.get).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(5);
    state.clear();
    await vi.advanceTimersByTimeAsync(300000);
    expect(api.get).toHaveBeenCalledTimes(5);
  } finally { state.clear(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers(); }
});

it.each(["manual refresh", "settings generation"])("resets failed checking recovery after %s", async reset => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  const api = { get: vi.fn().mockResolvedValueOnce(checkingCatalog())
    .mockRejectedValueOnce(new Error("Temporary transport failure")).mockResolvedValue(checkingCatalog()) };
  try {
    const binding = { api, generation: 0, identityKey: "fixture-owner:main" };
    state.observe(binding);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.get).toHaveBeenCalledTimes(2);
    if (reset === "manual refresh") state.refresh();
    else state.observe({ ...binding, generation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.get).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4999);
    expect(api.get).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(4);
    expect(state.getSnapshot().lastSuccessAt).toBeNull();
  } finally { state.clear(); client.clear(); vi.useRealTimers(); }
});

it("resets the failed checking budget after a healthy response", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  const api = { get: vi.fn().mockResolvedValueOnce(checkingCatalog())
    .mockRejectedValueOnce(new Error("Temporary transport failure"))
    .mockResolvedValueOnce(createCanonicalProviderCatalogFixture()).mockResolvedValue(checkingCatalog()) };
  try {
    state.observe({ api, generation: 0, identityKey: "fixture-owner:main" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(state.getSnapshot().catalog?.instances[0]?.availability).toBe("available");
    await vi.advanceTimersByTimeAsync(300000);
    expect(api.get).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4999);
    expect(api.get).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(5);
  } finally { state.clear(); client.clear(); vi.useRealTimers(); }
});

it("does not spend a new generation's checking budget on an obsolete failed request", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  let rejectOld!: (error: Error) => void;
  const old = new Promise((_resolve, reject) => { rejectOld = reject; });
  const api = { get: vi.fn().mockResolvedValueOnce(checkingCatalog()).mockReturnValueOnce(old).mockResolvedValue(checkingCatalog()) };
  try {
    const binding = { api, generation: 0, identityKey: "fixture-owner:main" };
    state.observe(binding);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.get).toHaveBeenCalledTimes(2);
    state.observe({ ...binding, generation: 1 });
    expect(state.getSnapshot().authoritySuspended).toBe(true);
    rejectOld(new Error("Obsolete transport failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(state.getSnapshot().refreshError).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.get).toHaveBeenCalledTimes(4);
  } finally { state.clear(); client.clear(); vi.useRealTimers(); }
});

it("retains ordinary nonchecking transport backoff and jitter", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const client = createDesktopQueryClient();
  const state = new ProviderCatalogCache(client);
  const api = { get: vi.fn().mockResolvedValueOnce(createCanonicalProviderCatalogFixture()).mockRejectedValue(new Error("Temporary transport failure")) };
  try {
    state.observe({ api, generation: 0, identityKey: "fixture-owner:main" });
    await vi.advanceTimersByTimeAsync(0);
    state.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31499);
    expect(api.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(3);
  } finally { state.clear(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers(); }
});
