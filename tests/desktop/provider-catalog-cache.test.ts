import { AppError } from "../../desktop/src/shared/app-error";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopQueryClient } from "../../desktop/src/renderer/src/lib/query-client";
import { ProviderCatalogCache, PROVIDER_CATALOG_FRESH_MS } from "../../desktop/src/renderer/src/features/chat/provider-catalog-cache";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
const fixture = createCanonicalProviderCatalogFixture();
const catalog = { ...fixture, instances: [...fixture.instances, { ...fixture.instances[0], id: "other_instance", defaultSelection: undefined }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const caches: ProviderCatalogCache[] = [];
function cache() { const value = new ProviderCatalogCache(createDesktopQueryClient()); caches.push(value); return value; }
const scope = (api: { get: ReturnType<typeof vi.fn> }, generation = 0, identityKey = "owner:primary") => ({ api, generation, identityKey });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { caches.splice(0).forEach(value => value.clear()); vi.useRealTimers(); vi.restoreAllMocks(); });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("Electron application provider cache", () => {
  it("prewarms without consumers and keeps a successful empty snapshot ready", async () => {
    const empty = { revision: "empty", drivers: [], instances: [] };
    const api = { get: vi.fn().mockResolvedValue(empty) };
    const state = cache(); state.observe(scope(api));
    expect(state.getSnapshot().refreshing).toBe(true);
    await settle();
    expect(state.getSnapshot()).toMatchObject({ catalog: empty, refreshing: false, lastSuccessAt: Date.now() });
    expect(api.get).toHaveBeenCalledOnce();
  });
  it("performs one silent routine read every five minutes while retaining the snapshot", async () => {
    const pending = deferred<typeof catalog>();
    const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockReturnValueOnce(pending.promise) };
    const state = cache(); state.observe(scope(api)); await settle();
    const snapshot = state.getSnapshot().catalog;
    await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_FRESH_MS - 1);
    expect(api.get).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(state.getSnapshot()).toMatchObject({ catalog: snapshot, refreshing: true, authoritySuspended: false });
    pending.resolve(catalog); await settle();
    expect(state.getSnapshot().catalog).toBe(snapshot);
    expect(api.get.mock.calls[1][0]).not.toContain("refresh=true");
  });
  it("retains semantic snapshot identity when only opaque revision metadata changes", async () => {
    const newer = { ...catalog, revision: "new_revision", instances: catalog.instances.map(i => ({ ...i, catalogRevision: "new_revision" })) };
    const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockResolvedValue(newer) };
    const state = cache(); state.observe(scope(api)); await settle();
    const snapshot = state.getSnapshot().catalog;
    state.refresh(); await settle();
    expect(state.getSnapshot().catalog).toBe(snapshot);
    expect(state.getSnapshot().refreshError).toBeNull();
  });
  it("uses replacement transports without discarding warm same-scope authority", async () => {
    const first = { get: vi.fn().mockResolvedValue(catalog) };
    const replacement = { get: vi.fn().mockResolvedValue(catalog) };
    const state = cache(); state.observe(scope(first)); await settle();
    const snapshot = state.getSnapshot().catalog;
    state.observe(scope(replacement));
    expect(state.getSnapshot().catalog).toBe(snapshot);
    expect(replacement.get).not.toHaveBeenCalled();
    state.refresh(); await settle();
    expect(replacement.get).toHaveBeenCalledOnce();
  });
  it("coalesces changes behind an older request and never restores revoked authority", async () => {
    const older = deferred<typeof catalog>();
    const newer = deferred<typeof catalog>();
    const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise) };
    const state = cache(); state.observe(scope(api)); await settle();
    state.refresh();
    state.observe(scope(api, 1)); state.observe(scope(api, 2)); state.refresh();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(state.getSnapshot().authoritySuspended).toBe(true);
    older.resolve(catalog); await settle();
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(state.getSnapshot().authoritySuspended).toBe(true);
    expect(api.get.mock.calls[2][0]).toContain("refresh=true");
    newer.reject(new Error("failed")); await settle();
    expect(state.getSnapshot()).toMatchObject({ authoritySuspended: true, refreshing: false });
    expect(state.getSnapshot().refreshError).toBeTruthy();
  });
  it("targets known routes and accumulates pending invalidations while unknown ones suspend all", async () => {
    const pending = deferred<typeof catalog>();
    const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockReturnValue(pending.promise) };
    const state = cache(); state.observe(scope(api)); await settle();
    state.observe({ ...scope(api, 1), affectedInstanceIds: [catalog.instances[0].id] });
    expect(state.getSnapshot()).toMatchObject({ authoritySuspended: true, suspendedInstanceIds: [catalog.instances[0].id] });
    state.observe({ ...scope(api, 2), affectedInstanceIds: [catalog.instances[1].id] });
    expect(state.getSnapshot().suspendedInstanceIds).toEqual([catalog.instances[0].id, catalog.instances[1].id]);
    state.observe(scope(api, 3));
    expect(state.getSnapshot().suspendedInstanceIds).toBeNull();
  });
  it("keeps warm data on failure and retries at 30 seconds, two minutes, then five minutes", async () => {
    const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockRejectedValue(new Error("offline")) };
    const state = cache(); state.observe(scope(api)); await settle();
    const snapshot = state.getSnapshot().catalog;
    state.refresh(); await settle();
    expect(state.getSnapshot()).toMatchObject({ catalog: snapshot, authoritySuspended: false });
    for (const [delay, count] of [[30_000, 3], [120_000, 4], [300_000, 5]]) {
      await vi.advanceTimersByTimeAsync(delay - 1); expect(api.get).toHaveBeenCalledTimes(count - 1);
      await vi.advanceTimersByTimeAsync(1); expect(api.get).toHaveBeenCalledTimes(count);
    }
    state.refresh(); await settle(); // Explicit validation bypasses backoff.
    expect(api.get).toHaveBeenCalledTimes(6);
  });
  it("pauses offline timers, schedules one due reconnect read, and respects fresh reconnects", async () => {
    const api = { get: vi.fn().mockResolvedValue(catalog) };
    const state = cache(); state.observe(scope(api)); await settle();
    state.setOnline(false); await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_FRESH_MS * 3);
    expect(api.get).toHaveBeenCalledOnce();
    state.setOnline(true); await settle(); expect(api.get).toHaveBeenCalledTimes(2);
    state.setOnline(false); state.setOnline(true); await settle(); expect(api.get).toHaveBeenCalledTimes(2);
  });
  it("cancels old identity requests, drops late replies and removes timers/cache on teardown", async () => {
    const old = deferred<typeof catalog>();
    const api = { get: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(catalog) };
    const state = cache(); state.observe(scope(api));
    const oldSignal = api.get.mock.calls[0][1].signal as AbortSignal;
    state.observe(scope(api, 0, "other:runtime")); await settle();
    expect(oldSignal.aborted).toBe(true);
    const snapshot = state.getSnapshot().catalog;
    old.resolve({ ...catalog, revision: "late", instances: catalog.instances.map(i => ({ ...i, catalogRevision: "late", displayName: "Old owner" })) }); await settle();
    expect(state.getSnapshot().catalog).toBe(snapshot);
    state.clear(); expect(state.getSnapshot().catalog).toBeNull();
    await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_FRESH_MS * 2); expect(api.get).toHaveBeenCalledTimes(2);
  });
  it("reconciles a sleep-delayed timer by elapsed wall-clock deadline", async () => {
    const api = { get: vi.fn().mockResolvedValue(catalog) };
    const state = cache(); state.observe(scope(api)); await settle();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});


it("suspends cached authority after authentication rejection while retaining safe same-scope labels", async () => {
  const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockRejectedValue(new AppError("unauthorized")) };
  const state = cache(); state.observe(scope(api)); await settle();
  state.refresh(); await settle();
  expect(state.getSnapshot().catalog).toEqual(catalog);
  expect(state.getSnapshot().authoritySuspended).toBe(true);
  expect(state.getSnapshot().suspendedInstanceIds).toBeNull();
});
